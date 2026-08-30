import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";
export type LocalAgentTurnStatus = "running" | "completed" | "failed" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
}

export interface LocalAgentTurnRecord {
  id: number;
  agentId: string;
  prompt: string;
  status: LocalAgentTurnStatus;
  response?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface BeginLocalAgentTurnInput {
  prompt: string;
  model?: string;
  effort?: string;
}

export type FinishLocalAgentTurnInput =
  | { status: "completed"; response?: string; providerSessionId?: string }
  | { status: "failed"; error: string; errorCode: string; errorRetryable: boolean }
  | { status: "stopped"; error?: string; errorCode?: string; errorRetryable?: boolean };

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
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalAgentTurnRow {
  id: number;
  agent_id: string;
  prompt: string;
  status: string;
  response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  completed_at: string | null;
}

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
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
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
          provider,
          model,
          effort,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
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
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  beginTurn(agentId: string, input: BeginLocalAgentTurnInput): BegunLocalAgentTurn {
    return this.database.sqlite.transaction(() => {
      const agent = this.update(agentId, {
        status: "running",
        model: input.model,
        effort: input.effort,
        latestResponse: undefined,
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
      });
      const result = this.database.sqlite
        .prepare(
          `insert into local_agent_turns (
            agent_id,
            prompt,
            status,
            created_at
          ) values (?, ?, 'running', ?)`,
        )
        .run(agentId, input.prompt, agent.updatedAt);
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
        });
      }
      return this.update(agentId, {
        status: completion.status === "failed" ? "error" : "stopped",
        latestResponse: undefined,
        error: completion.error,
        errorCode: completion.errorCode,
        errorRetryable: completion.errorRetryable,
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

  getLatestTurn(agentId: string): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where agent_id = ? order by id desc limit 1")
      .get(agentId) as LocalAgentTurnRow | undefined;
    return row ? rowToLocalAgentTurnRecord(row) : undefined;
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
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLocalAgentTurnRecord(row: LocalAgentTurnRow): LocalAgentTurnRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    status: readTurnStatus(row.status),
    response: row.response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
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
