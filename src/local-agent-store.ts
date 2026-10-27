import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import type { LocalAgentTurnEvent, LocalAgentTurnEventBody } from "./local-agent-events.js";
import { validateAgentId } from "./local-agent-id.js";
import type { LocalAgentDriverKind } from "./local-agent-provider.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export type LocalAgentTurnStatus = "running" | "completed" | "failed" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  /** The checkout the agent belongs to; it scopes `ls`, `show`, and `continue`. */
  workspaceRoot: string;
  /** Set for `--worktree` agents: the isolated checkout they run in, on `branch`. */
  worktreePath?: string;
  branch?: string;
  profileName: string;
  providerInstanceId: string;
  driver: LocalAgentDriverKind;
  model?: string;
  effort?: string;
  writeMode: LocalAgentWriteMode;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetail?: string;
  latestTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  id?: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  providerInstanceId: string;
  driver: LocalAgentDriverKind;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  dispatchSignature?: string;
}

export interface CreatedLocalAgentRecord {
  record: LocalAgentRecord;
  created: boolean;
}

export class LocalAgentDispatchConflictError extends Error {}

export interface LocalAgentTurnRecord {
  /** Store row identity; never leaves the daemon. */
  id: number;
  /** App-owned turn identity shown to hosts and attached to turn events. */
  turnId: string;
  agentId: string;
  prompt: string;
  status: LocalAgentTurnStatus;
  response?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetail?: string;
  createdAt: string;
  completedAt?: string;
}

export interface BeginLocalAgentTurnInput {
  turnId: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export type FinishLocalAgentTurnInput =
  | { status: "completed"; response?: string; providerSessionId?: string }
  | { status: "failed"; error: string; errorCode: string; errorRetryable: boolean; errorDetail?: string }
  | { status: "stopped"; error?: string; errorCode?: string; errorRetryable?: boolean; errorDetail?: string };

export interface BegunLocalAgentTurn {
  agent: LocalAgentRecord;
  turn: LocalAgentTurnRecord;
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider_instance_id: string;
  driver: LocalAgentDriverKind;
  model: string | null;
  effort: string | null;
  write_mode: string;
  dispatch_signature: string | null;
  worktree_path: string | null;
  branch: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  error_detail: string | null;
  latest_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalAgentTurnRow {
  id: number;
  turn_id: string;
  agent_id: string;
  prompt: string;
  status: string;
  response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
}

interface LocalAgentTurnEventRow {
  seq: number;
  type: string;
  data: string;
  created_at: string;
}

// Older turns keep their history row but drop their event log.
const TURNS_WITH_EVENTS_PER_AGENT = 20;

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];

    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    return this.createDispatch(input).record;
  }

  private createDispatch(input: CreateLocalAgentRecordInput): CreatedLocalAgentRecord {
    return this.database.sqlite.transaction(() => {
      const generate = () => `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      let id = input.id ?? generate();
      validateAgentId(id);
      let existing = this.getRowById(id);

      // Only caller-supplied ids are idempotent; a generated id that collides must never alias another agent.
      if (!input.id) {
        while (existing) {
          id = generate();
          existing = this.getRowById(id);
        }
      }

      if (existing) {
        const record = rowToLocalAgentRecord(existing);
        validateDispatchIdentity(record, input, existing.dispatch_signature);

        return { record, created: false };
      }

      const now = new Date().toISOString();

      const record: LocalAgentRecord = {
        id,
        workspaceId: input.workspaceId,
        workspaceRoot: resolve(input.workspaceRoot),
        profileName: input.profileName,
        providerInstanceId: input.providerInstanceId,
        driver: input.driver,
        model: input.model,
        effort: input.effort,
        writeMode: input.writeMode ?? "allowed",
        status: "starting",
        createdAt: now,
        updatedAt: now,
      };

      this.database.sqlite
        .prepare(
          `insert into local_agent_sessions (
            id,
            workspace_id,
            workspace_root,
            profile_name,
            provider_instance_id,
            driver,
            model,
            effort,
            write_mode,
            dispatch_signature,
            status,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workspaceId ?? null,
          record.workspaceRoot,
          record.profileName,
          record.providerInstanceId,
          record.driver,
          record.model ?? null,
          record.effort ?? null,
          record.writeMode,
          input.dispatchSignature ?? null,
          record.status,
          record.createdAt,
          record.updatedAt,
        );

      return { record, created: true };
    }).immediate();
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<CreatedLocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.createDispatch(input));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.getRowById(id);

    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  private getRowById(id: string): LocalAgentRow | undefined {
    return this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);

    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          worktree_path = ?,
          branch = ?,
          profile_name = ?,
          provider_instance_id = ?,
          driver = ?,
          model = ?,
          effort = ?,
          write_mode = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          error_detail = ?,
          latest_turn_id = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.worktreePath ?? null,
        updated.branch ?? null,
        updated.profileName,
        updated.providerInstanceId,
        updated.driver,
        updated.model ?? null,
        updated.effort ?? null,
        updated.writeMode,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.errorDetail ?? null,
        updated.latestTurnId ?? null,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  /** Drops a record that never ran, so its caller-supplied id can be reused. */
  delete(id: string): void {
    this.database.sqlite.prepare("delete from local_agent_sessions where id = ?").run(id);
  }

  deleteResult(id: string): BetterResult<void, AgentStoreError> {
    return storeResult("delete", () => this.delete(id));
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  beginTurn(agentId: string, input: BeginLocalAgentTurnInput): BegunLocalAgentTurn {
    return this.database.sqlite.transaction(() => {
      const current = this.getById(agentId);

      if (!current) throw new Error(`Unknown subagent id: ${agentId}`);

      if (current.status === "running") {
        throw new Error(`Subagent ${agentId} already has a running turn.`);
      }

      const agent = this.update(agentId, {
        status: "running",
        model: input.model,
        effort: input.effort,
        writeMode: input.writeMode ?? current.writeMode,
        latestResponse: undefined,
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
        errorDetail: undefined,
        latestTurnId: input.turnId,
      });

      const result = this.database.sqlite
        .prepare(
          `insert into local_agent_turns (
            turn_id,
            agent_id,
            prompt,
            status,
            created_at
          ) values (?, ?, ?, 'running', ?)`,
        )
        .run(input.turnId, agentId, input.prompt, agent.updatedAt);

      this.database.sqlite
        .prepare(
          `delete from local_agent_turn_events
           where turn_row_id in (
             select id from local_agent_turns where agent_id = ?
             order by id desc limit -1 offset ?
           )`,
        )
        .run(agentId, TURNS_WITH_EVENTS_PER_AGENT);
      const turn = this.getTurnById(Number(result.lastInsertRowid));

      if (!turn) throw new Error(`Unable to load the new turn for subagent ${agentId}.`);

      return { agent, turn };
    }).immediate();
  }

  beginTurnResult(
    agentId: string,
    input: BeginLocalAgentTurnInput,
  ): BetterResult<BegunLocalAgentTurn, AgentStoreError> {
    return storeResult("begin_turn", () => this.beginTurn(agentId, input));
  }

  finishTurn(
    agentId: string,
    turnId: number,
    completion: FinishLocalAgentTurnInput,
  ): LocalAgentRecord {
    return this.database.sqlite.transaction(() => {
      const turn = this.getTurnById(turnId);

      if (!turn || turn.agentId !== agentId) {
        throw new Error(`Unknown turn ${turnId} for subagent ${agentId}.`);
      }

      if (turn.status !== "running") {
        throw new Error(`Turn ${turnId} for subagent ${agentId} is already ${turn.status}.`);
      }

      const currentAgent = this.getById(agentId);

      if (!currentAgent) throw new Error(`Unknown subagent id: ${agentId}`);

      const completedAt = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `update local_agent_turns set
            status = ?,
            response = ?,
            error = ?,
            error_code = ?,
            error_retryable = ?,
            error_detail = ?,
            completed_at = ?
           where id = ? and agent_id = ?`,
        )
        .run(
          completion.status,
          completion.status === "completed" ? completion.response ?? null : null,
          completion.status === "completed" ? null : completion.error ?? null,
          completion.status === "completed" ? null : completion.errorCode ?? null,
          completion.status === "completed" || completion.errorRetryable === undefined
            ? null
            : String(completion.errorRetryable),
          completion.status === "completed" ? null : completion.errorDetail ?? null,
          completedAt,
          turnId,
          agentId,
        );

      if (completion.status === "completed") {
        return this.update(agentId, {
          providerSessionId: completion.providerSessionId ?? currentAgent.providerSessionId,
          status: "idle",
          latestResponse: completion.response,
          error: undefined,
          errorCode: undefined,
          errorRetryable: undefined,
          errorDetail: undefined,
        });
      }

      return this.update(agentId, {
        status: completion.status === "failed" ? "error" : "stopped",
        latestResponse: undefined,
        error: completion.error,
        errorCode: completion.errorCode,
        errorRetryable: completion.errorRetryable,
        errorDetail: completion.errorDetail,
      });
    }).immediate();
  }

  finishTurnResult(
    agentId: string,
    turnId: number,
    completion: FinishLocalAgentTurnInput,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("finish_turn", () => this.finishTurn(agentId, turnId, completion));
  }

  getTurnById(turnId: number): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where id = ? limit 1")
      .get(turnId) as LocalAgentTurnRow | undefined;

    return row ? rowToLocalAgentTurnRecord(row) : undefined;
  }

  getTurnByIdResult(
    turnId: number,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentStoreError> {
    return storeResult("get_turn", () => this.getTurnById(turnId));
  }

  getTurnByTurnId(turnId: string): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where turn_id = ? limit 1")
      .get(turnId) as LocalAgentTurnRow | undefined;

    return row ? rowToLocalAgentTurnRecord(row) : undefined;
  }

  getTurnByTurnIdResult(
    turnId: string,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentStoreError> {
    return storeResult("get_turn", () => this.getTurnByTurnId(turnId));
  }

  appendTurnEvent(turn: LocalAgentTurnRecord, seq: number, event: LocalAgentTurnEventBody, at: string): void {
    this.database.sqlite
      .prepare(
        `insert into local_agent_turn_events (turn_row_id, seq, type, data, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(turn.id, seq, event.type, JSON.stringify(event), at);
  }

  appendTurnEventResult(
    turn: LocalAgentTurnRecord,
    seq: number,
    event: LocalAgentTurnEventBody,
    at: string,
  ): BetterResult<void, AgentStoreError> {
    return storeResult("append_turn_event", () => this.appendTurnEvent(turn, seq, event, at));
  }

  listTurnEvents(turn: LocalAgentTurnRecord, afterSeq = 0): LocalAgentTurnEvent[] {
    const rows = this.database.sqlite
      .prepare(
        `select seq, type, data, created_at from local_agent_turn_events
         where turn_row_id = ? and seq > ?
         order by seq asc`,
      )
      .all(turn.id, afterSeq) as LocalAgentTurnEventRow[];

    return rows.map((row) => ({
      ...(JSON.parse(row.data) as LocalAgentTurnEventBody),
      turnId: turn.turnId,
      seq: row.seq,
      at: row.created_at,
    }));
  }

  listTurnEventsResult(
    turn: LocalAgentTurnRecord,
    afterSeq?: number,
  ): BetterResult<LocalAgentTurnEvent[], AgentStoreError> {
    return storeResult("list_turn_events", () => this.listTurnEvents(turn, afterSeq));
  }

  getLatestTurn(agentId: string): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where agent_id = ? order by id desc limit 1")
      .get(agentId) as LocalAgentTurnRow | undefined;

    return row ? rowToLocalAgentTurnRecord(row) : undefined;
  }

  getLatestTurnResult(
    agentId: string,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentStoreError> {
    return storeResult("get_latest_turn", () => this.getLatestTurn(agentId));
  }

  listTurns(agentId: string): LocalAgentTurnRecord[] {
    const rows = this.database.sqlite
      .prepare("select * from local_agent_turns where agent_id = ? order by id asc")
      .all(agentId) as LocalAgentTurnRow[];

    return rows.map(rowToLocalAgentTurnRecord);
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    return this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `update local_agent_turns
           set status = 'failed', error = ?, error_code = 'DAEMON_UNAVAILABLE',
               error_retryable = 'true', completed_at = ?
           where status = 'running'`,
        )
        .run(message, now);

      const result = this.database.sqlite
        .prepare(
          `update local_agent_sessions
           set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
           where status in ('starting', 'running')`,
        )
        .run(message, now);

      return Number(result.changes);
    }).immediate();
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  close(): void {
    this.database.close();
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    worktreePath: row.worktree_path ?? undefined,
    branch: row.branch ?? undefined,
    profileName: row.profile_name,
    providerInstanceId: row.provider_instance_id,
    driver: row.driver,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    writeMode: readWriteMode(row.write_mode),
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    errorDetail: row.error_detail ?? undefined,
    latestTurnId: row.latest_turn_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLocalAgentTurnRecord(row: LocalAgentTurnRow): LocalAgentTurnRecord {
  return {
    id: row.id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    prompt: row.prompt,
    status: readTurnStatus(row.status),
    response: row.response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    errorDetail: row.error_detail ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function readTurnStatus(status: string): LocalAgentTurnStatus {
  if (status === "running" || status === "completed" || status === "failed" || status === "stopped") {
    return status;
  }

  throw new Error(`Invalid stored local agent turn status: ${status}`);
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;

  if (value === "false") return false;

  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;

    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }

  return "error";
}

function readWriteMode(value: string): LocalAgentWriteMode {
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  throw new Error(`Invalid stored local agent write mode: ${value}`);
}

function validateDispatchIdentity(
  existing: LocalAgentRecord,
  input: CreateLocalAgentRecordInput,
  storedSignature: string | null,
): void {
  const expected = {
    workspaceId: input.workspaceId,
    workspaceRoot: resolve(input.workspaceRoot),
    profileName: input.profileName,
    providerInstanceId: input.providerInstanceId,
    driver: input.driver,
  };

  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (existing[key] !== expected[key]) {
      throw new LocalAgentDispatchConflictError(
        `Subagent id ${existing.id} is already owned by a different dispatch.`,
      );
    }
  }

  if (storedSignature !== (input.dispatchSignature ?? null)) {
    throw new LocalAgentDispatchConflictError(
      `Subagent id ${existing.id} is already owned by a different dispatch.`,
    );
  }

  if (storedSignature !== null) return;

  if (
    existing.model !== input.model
    || existing.effort !== input.effort
    || existing.writeMode !== (input.writeMode ?? "allowed")
  ) {
    throw new LocalAgentDispatchConflictError(
      `Subagent id ${existing.id} is already owned by a different dispatch.`,
    );
  }
}
