import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import {
  WORKFLOW_LIMITS,
  type AgentIsolationMode,
  type AppendWorkflowEventInput,
  type WorkflowAgentCallRecord,
  type WorkflowAgentCallStatus,
  type WorkflowErrorKind,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
  type WorkflowRunSource,
  type WorkflowRunStatus,
} from "./workflow-types.js";
import {
  localAgentProviderSchema,
  parseWorkflowEventPayload,
  workflowAgentCallStatusSchema,
  workflowEventTypeSchema,
  workflowRunSourceSchema,
  workflowRunStatusSchema,
} from "./workflow-contracts.js";
import {
  InvalidRunTransitionError,
  WorkflowNotFoundError,
  WorkflowStoreError,
} from "./workflow-errors.js";

export type WorkflowRunTransitionError =
  | WorkflowNotFoundError
  | InvalidRunTransitionError
  | WorkflowStoreError;

export interface CreateWorkflowRunInput {
  name: string;
  source: WorkflowRunSource;
  scriptPath: string;
  scriptHash: string;
  workspaceRoot: string;
  workspaceId?: string;
  argsJson?: string;
  resumedFromRunId?: string;
  baseSha?: string;
}

export interface BeginAgentCallInput {
  runId: string;
  callIndex: number;
  cacheKey: string;
  prompt: string;
  schemaJson?: string;
  provider: string;
  model?: string;
  effort?: string;
  profileName?: string;
  profileFingerprint?: string;
  label?: string;
  phase?: string;
  isolation?: AgentIsolationMode;
  worktreePath?: string;
  replayMatch?: "same_index";
  replayedFromRunId?: string;
  replayedFromCallIndex?: number;
  replayReason?: string;
}

export interface CompleteAgentCallInput {
  runId: string;
  callIndex: number;
  responseText?: string;
  structuredJson?: string;
  returnValueJson?: string;
  providerSessionId?: string;
  dirty?: boolean;
  worktreePath?: string;
  fromCache?: boolean;
}

export interface CacheAgentCallInput extends BeginAgentCallInput {
  replayMatch: "same_index";
  replayedFromRunId: string;
  replayedFromCallIndex: number;
  responseText?: string;
  structuredJson?: string;
  returnValueJson?: string;
  providerSessionId?: string;
}

export interface FailAgentCallInput {
  runId: string;
  callIndex: number;
  error: string;
  errorKind?: WorkflowErrorKind;
  worktreePath?: string;
  dirty?: boolean;
  cleanupError?: string;
}

export interface CompleteRunInput {
  resultJson?: string;
  callCount?: number;
}

export interface FailRunInput {
  error: string;
  errorKind?: WorkflowErrorKind;
}

export interface DrainEventsResult {
  events: WorkflowEventRecord[];
  nextSeq: number;
  hasMore: boolean;
  terminal: boolean;
  run: WorkflowRunRecord;
}

export interface WorkflowRunScope {
  workspaceId?: string;
  workspaceRoot: string;
}

interface WorkflowRunRow {
  id: string;
  name: string;
  source: string;
  script_path: string;
  script_hash: string;
  workspace_root: string;
  workspace_id: string | null;
  args_json: string;
  status: string;
  error: string | null;
  error_kind: string | null;
  result_json: string | null;
  pid: number | null;
  heartbeat_at: string | null;
  cancel_requested: string;
  resumed_from_run_id: string | null;
  base_sha: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface WorkflowEventRow {
  run_id: string;
  seq: number;
  type: string;
  phase: string | null;
  label: string | null;
  data_json: string;
  created_at: string;
}

interface WorkflowAgentCallRow {
  run_id: string;
  call_index: number;
  cache_key: string;
  prompt: string;
  schema_json: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  profile_name: string | null;
  profile_fingerprint: string | null;
  label: string | null;
  phase: string | null;
  status: string;
  from_cache: string;
  provider_session_id: string | null;
  response_text: string | null;
  structured_json: string | null;
  return_value_json: string | null;
  error: string | null;
  error_kind: string | null;
  replay_match: string | null;
  replayed_from_run_id: string | null;
  replayed_from_call_index: number | null;
  replay_reason: string | null;
  isolation: string;
  worktree_path: string | null;
  dirty: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]);

export class WorkflowStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createRun(input: CreateWorkflowRunInput): WorkflowRunRecord {
    const now = isoNow();
    const argsJson = input.argsJson ?? "null";
    assertArgsSize(argsJson);

    const record: WorkflowRunRecord = {
      id: `wfr_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      name: input.name,
      source: input.source,
      scriptPath: input.scriptPath,
      scriptHash: input.scriptHash,
      workspaceRoot: resolve(input.workspaceRoot),
      workspaceId: input.workspaceId,
      argsJson,
      status: "starting",
      cancelRequested: false,
      resumedFromRunId: input.resumedFromRunId,
      baseSha: input.baseSha,
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into workflow_runs (
          id, name, source, script_path, script_hash, workspace_root, workspace_id,
          args_json, status, cancel_requested, resumed_from_run_id, base_sha,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.source,
        record.scriptPath,
        record.scriptHash,
        record.workspaceRoot,
        record.workspaceId ?? null,
        record.argsJson,
        record.status,
        "false",
        record.resumedFromRunId ?? null,
        record.baseSha ?? null,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  getRun(id: string): WorkflowRunRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from workflow_runs where id = ?")
      .get(id) as WorkflowRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getRunResult(
    id: string,
  ): BetterResult<WorkflowRunRecord | undefined, WorkflowStoreError> {
    return Result.try({
      try: () => this.getRun(id),
      catch: (cause) => new WorkflowStoreError("get_run", cause),
    });
  }

  listRuns(limit = 50): WorkflowRunRecord[] {
    const rows = this.database.sqlite
      .prepare("select * from workflow_runs order by updated_at desc limit ?")
      .all(Math.max(1, Math.min(limit, 500))) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  listRunsForWorkspace(
    workspaceRoot: string,
    options: {
      statuses?: WorkflowRunStatus[];
      limit?: number;
    } = {},
  ): WorkflowRunRecord[] {
    const root = resolve(workspaceRoot);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const statuses = options.statuses?.filter((status, index, values) =>
      values.indexOf(status) === index,
    );

    if (!statuses?.length) {
      const rows = this.database.sqlite
        .prepare(
          "select * from workflow_runs where workspace_root = ? order by updated_at desc limit ?",
        )
        .all(root, limit) as WorkflowRunRow[];
      return rows.map(rowToRun);
    }

    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_runs
         where workspace_root = ? and status in (${placeholders})
         order by updated_at desc
         limit ?`,
      )
      .all(root, ...statuses, limit) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  listRunsForScope(
    scope: WorkflowRunScope,
    options: {
      statuses?: WorkflowRunStatus[];
      limit?: number;
    } = {},
  ): WorkflowRunRecord[] {
    if (!scope.workspaceId) return this.listRunsForWorkspace(scope.workspaceRoot, options);

    const root = resolve(scope.workspaceRoot);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const statuses = options.statuses?.filter((status, index, values) =>
      values.indexOf(status) === index,
    );
    if (!statuses?.length) {
      const rows = this.database.sqlite
        .prepare(
          `select * from workflow_runs
           where workspace_id = ? or (workspace_id is null and workspace_root = ?)
           order by updated_at desc limit ?`,
        )
        .all(scope.workspaceId, root, limit) as WorkflowRunRow[];
      return rows.map(rowToRun);
    }

    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_runs
         where (workspace_id = ? or (workspace_id is null and workspace_root = ?))
           and status in (${placeholders})
         order by updated_at desc
         limit ?`,
      )
      .all(scope.workspaceId, root, ...statuses, limit) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Atomically claim a starting run for the worker.
   * Returns undefined if the run is missing or not claimable.
   */
  setScriptPath(id: string, scriptPath: string): WorkflowRunRecord {
    return unwrapRunResult(this.setScriptPathResult(id, scriptPath));
  }

  setScriptPathResult(
    id: string,
    scriptPath: string,
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    const current = this.getRunResult(id);
    if (current.isErr()) return Result.err(current.error);
    const run = current.value;
    if (!run) return Result.err(new WorkflowNotFoundError(id));
    const updated = Result.try({
      try: () => {
        const now = isoNow();
        this.database.sqlite
          .prepare(
            `UPDATE workflow_runs SET script_path = ?, updated_at = ? WHERE id = ?`,
          )
          .run(scriptPath, now, id);
        return this.getRun(id);
      },
      catch: (cause) => new WorkflowStoreError("set_script_path", cause),
    });
    if (updated.isErr()) return Result.err(updated.error);
    return updated.value
      ? Result.ok(updated.value)
      : Result.err(new WorkflowNotFoundError(id));
  }

  claimRun(id: string, pid: number): WorkflowRunRecord | undefined {
    const result = this.claimRunResult(id, pid);
    if (result.isOk()) return result.value;
    if (
      WorkflowNotFoundError.is(result.error) ||
      InvalidRunTransitionError.is(result.error)
    ) {
      return undefined;
    }
    throw result.error;
  }

  claimRunResult(
    id: string,
    pid: number,
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    const currentResult = this.getRunResult(id);
    if (currentResult.isErr()) return Result.err(currentResult.error);
    const current = currentResult.value;
    if (!current) return Result.err(new WorkflowNotFoundError(id));
    if (current.status !== "starting") {
      return Result.err(
        new InvalidRunTransitionError({
          runId: id,
          from: current.status,
          operation: "claim",
        }),
      );
    }

    const claimed = Result.try({
      try: () => {
        const now = isoNow();
        const update = this.database.sqlite
          .prepare(
            `update workflow_runs set
              status = 'running',
              pid = ?,
              heartbeat_at = ?,
              started_at = coalesce(started_at, ?),
              updated_at = ?
             where id = ? and status = 'starting'`,
          )
          .run(pid, now, now, now, id);
        return update.changes;
      },
      catch: (cause) => new WorkflowStoreError("claim_run", cause),
    });
    if (claimed.isErr()) return Result.err(claimed.error);
    if (claimed.value === 0) {
      const latestResult = this.getRunResult(id);
      if (latestResult.isErr()) return Result.err(latestResult.error);
      const latest = latestResult.value;
      return latest
        ? Result.err(
            new InvalidRunTransitionError({
              runId: id,
              from: latest.status,
              operation: "claim",
            }),
          )
        : Result.err(new WorkflowNotFoundError(id));
    }
    const runResult = this.getRunResult(id);
    if (runResult.isErr()) return Result.err(runResult.error);
    const run = runResult.value;
    return run ? Result.ok(run) : Result.err(new WorkflowNotFoundError(id));
  }

  setHeartbeat(id: string, at = isoNow()): void {
    this.database.sqlite
      .prepare(
        `update workflow_runs set heartbeat_at = ?, updated_at = ? where id = ? and status = 'running'`,
      )
      .run(at, at, id);
  }

  requestCancel(id: string): WorkflowRunRecord {
    return unwrapRunResult(this.requestCancelResult(id));
  }

  requestCancelResult(
    id: string,
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    const current = this.getRunResult(id);
    if (current.isErr()) return Result.err(current.error);
    const run = current.value;
    if (!run) return Result.err(new WorkflowNotFoundError(id));
    if (TERMINAL_STATUSES.has(run.status)) return Result.ok(run);

    const updated = Result.try({
      try: () => {
        const now = isoNow();
        const update = this.database.sqlite
          .prepare(
            `update workflow_runs
             set cancel_requested = 'true', updated_at = ?
             where id = ? and status in ('starting', 'running')`,
          )
          .run(now, id);
        if (update.changes === 0) return this.getRun(id);
        return this.getRun(id);
      },
      catch: (cause) => new WorkflowStoreError("request_cancel", cause),
    });
    if (updated.isErr()) return Result.err(updated.error);
    return updated.value
      ? Result.ok(updated.value)
      : Result.err(new WorkflowNotFoundError(id));
  }

  isCancelRequested(id: string): boolean {
    return this.requireRun(id).cancelRequested;
  }

  completeRun(id: string, input: CompleteRunInput = {}): WorkflowRunRecord {
    return unwrapRunResult(this.completeRunResult(id, input));
  }

  completeRunResult(
    id: string,
    input: CompleteRunInput = {},
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    return this.transitionRunResult(id, "complete", () => {
      if (input.resultJson !== undefined) assertResultSize(input.resultJson);
      const now = isoNow();
      const transaction = this.database.sqlite.transaction(() => {
        const changes = this.database.sqlite
          .prepare(
            `update workflow_runs set
              status = 'completed',
              result_json = ?,
              completed_at = ?,
              updated_at = ?,
              error = null,
              error_kind = null
             where id = ? and status in ('starting', 'running')`,
          )
          .run(input.resultJson ?? null, now, now, id).changes;
        if (changes === 0) return 0;
        this.insertEventRow(
          {
            runId: id,
            type: "run_completed",
            data: { callCount: input.callCount ?? 0 },
          },
          now,
        );
        return changes;
      });
      return transaction.immediate();
    });
  }

  failRun(id: string, input: FailRunInput): WorkflowRunRecord {
    return unwrapRunResult(this.failRunResult(id, input));
  }

  failRunResult(
    id: string,
    input: FailRunInput,
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    return this.transitionRunResult(id, "fail", () => {
      const now = isoNow();
      const errorKind = input.errorKind ?? "internal";
      const transaction = this.database.sqlite.transaction(() => {
        const changes = this.database.sqlite
          .prepare(
            `update workflow_runs set
              status = 'failed',
              error = ?,
              error_kind = ?,
              completed_at = ?,
              updated_at = ?
             where id = ? and status in ('starting', 'running')`,
          )
          .run(input.error, errorKind, now, now, id).changes;
        if (changes === 0) return 0;
        this.insertEventRow(
          {
            runId: id,
            type: "run_failed",
            data: { error: input.error, errorKind },
          },
          now,
        );
        return changes;
      });
      return transaction.immediate();
    });
  }

  cancelRun(id: string, error = "cancelled"): WorkflowRunRecord {
    return unwrapRunResult(this.cancelRunResult(id, error));
  }

  cancelRunResult(
    id: string,
    error = "cancelled",
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    return this.transitionRunResult(id, "cancel", () => {
      const now = isoNow();
      const transaction = this.database.sqlite.transaction(() => {
        const changes = this.database.sqlite
          .prepare(
            `update workflow_runs set
              status = 'cancelled',
              error = ?,
              error_kind = 'cancelled',
              cancel_requested = 'true',
              completed_at = ?,
              updated_at = ?
             where id = ? and status in ('starting', 'running')`,
          )
          .run(error, now, now, id).changes;
        if (changes === 0) return 0;
        this.insertEventRow(
          {
            runId: id,
            type: "run_cancelled",
            data: { reason: error },
          },
          now,
        );
        return changes;
      });
      return transaction.immediate();
    });
  }

  private transitionRunResult(
    id: string,
    operation: "complete" | "fail" | "cancel",
    update: () => number,
  ): BetterResult<WorkflowRunRecord, WorkflowRunTransitionError> {
    const currentResult = this.getRunResult(id);
    if (currentResult.isErr()) return Result.err(currentResult.error);
    const current = currentResult.value;
    if (!current) return Result.err(new WorkflowNotFoundError(id));
    if (TERMINAL_STATUSES.has(current.status)) return Result.ok(current);

    const updated = Result.try({
      try: update,
      catch: (cause) => new WorkflowStoreError(`${operation}_run`, cause),
    });
    if (updated.isErr()) return Result.err(updated.error);
    if (updated.value === 0) {
      const latestResult = this.getRunResult(id);
      if (latestResult.isErr()) return Result.err(latestResult.error);
      const latest = latestResult.value;
      if (!latest) return Result.err(new WorkflowNotFoundError(id));
      if (TERMINAL_STATUSES.has(latest.status)) return Result.ok(latest);
      return Result.err(
        new InvalidRunTransitionError({
          runId: id,
          from: latest.status,
          operation,
        }),
      );
    }
    const runResult = this.getRunResult(id);
    if (runResult.isErr()) return Result.err(runResult.error);
    const run = runResult.value;
    return run ? Result.ok(run) : Result.err(new WorkflowNotFoundError(id));
  }

  appendEvent(input: AppendWorkflowEventInput): WorkflowEventRecord {
    const createdAt = isoNow();
    const transaction = this.database.sqlite.transaction(() =>
      this.insertEventRow(input, createdAt),
    );
    return transaction.immediate();
  }

  drainEvents(runId: string, sinceSeq = 0, limit: number = WORKFLOW_LIMITS.eventDrainDefault): DrainEventsResult {
    const run = this.requireRun(runId);
    const capped = Math.max(1, Math.min(limit, WORKFLOW_LIMITS.eventDrainMax));
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_events
         where run_id = ? and seq > ?
         order by seq asc
         limit ?`,
      )
      .all(runId, sinceSeq, capped + 1) as WorkflowEventRow[];
    const hasMore = rows.length > capped;
    const events = rows.slice(0, capped).map(rowToEvent);
    const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : sinceSeq;
    return {
      events,
      nextSeq,
      hasMore,
      terminal: TERMINAL_STATUSES.has(run.status) && !hasMore,
      run,
    };
  }

  listEvents(runId: string, limit = 100): WorkflowEventRecord[] {
    const capped = Math.max(1, Math.min(limit, WORKFLOW_LIMITS.eventDrainMax));
    const rows = this.database.sqlite
      .prepare(
        `select * from (
           select * from workflow_events
           where run_id = ?
           order by seq desc
           limit ?
         ) order by seq asc`,
      )
      .all(runId, capped) as WorkflowEventRow[];
    return rows.map(rowToEvent);
  }

  startAgentCall(input: BeginAgentCallInput): WorkflowAgentCallRecord {
    const now = isoNow();
    const transaction = this.database.sqlite.transaction(() => {
      const call = this.insertAgentCallRow(input, now);
      this.insertEventRow(
        {
          runId: input.runId,
          type: "agent_call_started",
          phase: input.phase,
          label: input.label,
          data: {
            callIndex: input.callIndex,
            cacheKey: input.cacheKey,
            provider: call.provider,
            isolation: call.isolation,
            worktreePath: call.worktreePath,
          },
        },
        now,
      );
      return call;
    });
    return transaction.immediate();
  }

  cacheAgentCall(input: CacheAgentCallInput): WorkflowAgentCallRecord {
    this.assertAgentCallResultSizes(input);
    const now = isoNow();
    const transaction = this.database.sqlite.transaction(() => {
      this.insertAgentCallRow(input, now);
      const call = this.updateCompletedAgentCallRow(
        {
          runId: input.runId,
          callIndex: input.callIndex,
          responseText: input.responseText,
          structuredJson: input.structuredJson,
          returnValueJson: input.returnValueJson,
          providerSessionId: input.providerSessionId,
          fromCache: true,
        },
        now,
      );
      this.insertEventRow(
        {
          runId: input.runId,
          type: "agent_call_cached",
          phase: input.phase,
          label: input.label,
          data: {
            callIndex: input.callIndex,
            cacheKey: input.cacheKey,
            provider: call.provider,
            replayMatch: input.replayMatch,
            replayedFromRunId: input.replayedFromRunId,
            replayedFromCallIndex: input.replayedFromCallIndex,
          },
        },
        now,
      );
      return call;
    });
    return transaction.immediate();
  }

  private insertAgentCallRow(
    input: BeginAgentCallInput,
    now: string,
  ): WorkflowAgentCallRecord {
    const isolation: AgentIsolationMode = input.isolation === "worktree" ? "worktree" : "shared";
    this.database.sqlite
      .prepare(
        `insert into workflow_agent_calls (
          run_id, call_index, cache_key, prompt, schema_json, provider, model, effort,
          profile_name, profile_fingerprint, label, phase,
          status, from_cache, isolation, worktree_path, replay_match,
          replayed_from_run_id, replayed_from_call_index, replay_reason,
          created_at, started_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'false', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.callIndex,
        input.cacheKey,
        input.prompt,
        input.schemaJson ?? null,
        input.provider,
        input.model ?? null,
        input.effort ?? null,
        input.profileName ?? null,
        input.profileFingerprint ?? null,
        input.label ?? null,
        input.phase ?? null,
        isolation,
        input.worktreePath ?? null,
        input.replayMatch ?? null,
        input.replayedFromRunId ?? null,
        input.replayedFromCallIndex ?? null,
        input.replayReason ?? null,
        now,
        now,
        now,
      );
    return this.requireAgentCall(input.runId, input.callIndex);
  }

  completeAgentCall(input: CompleteAgentCallInput): WorkflowAgentCallRecord {
    this.assertAgentCallResultSizes(input);
    const now = isoNow();
    const transaction = this.database.sqlite.transaction(() => {
      const call = this.updateCompletedAgentCallRow(input, now);
      this.insertEventRow(
        {
          runId: input.runId,
          type: "agent_call_completed",
          phase: call.phase,
          label: call.label,
          data: {
            callIndex: input.callIndex,
            provider: call.provider,
            isolation: call.isolation,
            worktreePath: call.worktreePath,
            dirty: call.dirty,
            fromCache: call.fromCache,
          },
        },
        now,
      );
      return call;
    });
    return transaction.immediate();
  }

  private updateCompletedAgentCallRow(
    input: CompleteAgentCallInput,
    now: string,
  ): WorkflowAgentCallRecord {
    const status: WorkflowAgentCallStatus = input.fromCache ? "from_cache" : "completed";
    this.database.sqlite
      .prepare(
        `update workflow_agent_calls set
          status = ?,
          from_cache = ?,
          response_text = ?,
          structured_json = ?,
          return_value_json = ?,
          provider_session_id = coalesce(?, provider_session_id),
          worktree_path = coalesce(?, worktree_path),
          dirty = ?,
          completed_at = ?,
          updated_at = ?
         where run_id = ? and call_index = ?`,
      )
      .run(
        status,
        input.fromCache ? "true" : "false",
        input.responseText ?? null,
        input.structuredJson ?? null,
        input.returnValueJson ?? null,
        input.providerSessionId ?? null,
        input.worktreePath ?? null,
        input.dirty === undefined ? null : input.dirty ? "true" : "false",
        now,
        now,
        input.runId,
        input.callIndex,
      );
    return this.requireAgentCall(input.runId, input.callIndex);
  }

  failAgentCall(input: FailAgentCallInput): WorkflowAgentCallRecord {
    const now = isoNow();
    const transaction = this.database.sqlite.transaction(() => {
      const call = this.updateFailedAgentCallRow(input, now);
      this.insertEventRow(
        {
          runId: input.runId,
          type: "agent_call_failed",
          phase: call.phase,
          label: call.label,
          data: {
            callIndex: input.callIndex,
            error: input.error,
            cleanupError: input.cleanupError,
            isolation: call.isolation,
            worktreePath: call.worktreePath,
          },
        },
        now,
      );
      return call;
    });
    return transaction.immediate();
  }

  private updateFailedAgentCallRow(
    input: FailAgentCallInput,
    now: string,
  ): WorkflowAgentCallRecord {
    this.database.sqlite
      .prepare(
        `update workflow_agent_calls set
          status = 'failed',
          error = ?,
          error_kind = ?,
          worktree_path = coalesce(?, worktree_path),
          dirty = ?,
          completed_at = ?,
          updated_at = ?
         where run_id = ? and call_index = ?`,
      )
      .run(
        input.error,
        input.errorKind ?? "internal",
        input.worktreePath ?? null,
        input.dirty === undefined ? null : input.dirty ? "true" : "false",
        now,
        now,
        input.runId,
        input.callIndex,
      );
    return this.requireAgentCall(input.runId, input.callIndex);
  }

  private assertAgentCallResultSizes(input: {
    responseText?: string;
    structuredJson?: string;
    returnValueJson?: string;
  }): void {
    if (input.responseText !== undefined) {
      assertTextSize(input.responseText, WORKFLOW_LIMITS.responseTextBytes, "responseText");
    }
    if (input.structuredJson !== undefined) {
      assertTextSize(input.structuredJson, WORKFLOW_LIMITS.structuredJsonBytes, "structuredJson");
    }
    if (input.returnValueJson !== undefined) {
      assertTextSize(
        input.returnValueJson,
        WORKFLOW_LIMITS.replayValueJsonBytes,
        "returnValueJson",
      );
    }
  }

  getAgentCall(runId: string, callIndex: number): WorkflowAgentCallRecord | undefined {
    const row = this.database.sqlite
      .prepare(`select * from workflow_agent_calls where run_id = ? and call_index = ?`)
      .get(runId, callIndex) as WorkflowAgentCallRow | undefined;
    return row ? rowToAgentCall(row) : undefined;
  }

  listAgentCalls(runId: string): WorkflowAgentCallRecord[] {
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_agent_calls where run_id = ? order by call_index asc`,
      )
      .all(runId) as WorkflowAgentCallRow[];
    return rows.map(rowToAgentCall);
  }

  /**
   * Mark abandoned starting runs and running runs with a dead worker as failed.
   * staleBeforeMs: start/update or heartbeat older than this and no live pid.
   */
  reapStale(staleBeforeMs = 60_000, nowMs = Date.now()): WorkflowRunRecord[] {
    const cutoff = new Date(nowMs - staleBeforeMs).toISOString();
    const candidates = this.database.sqlite
      .prepare(
        `select * from workflow_runs
         where (status = 'running' and heartbeat_at is not null and heartbeat_at < ?)
            or (status = 'starting' and updated_at < ?)`,
      )
      .all(cutoff, cutoff) as WorkflowRunRow[];

    const reaped: WorkflowRunRecord[] = [];
    for (const row of candidates) {
      const latest = this.getRun(row.id);
      if (!latest || (latest.status !== "running" && latest.status !== "starting")) continue;
      if (latest.pid !== undefined && isPidAlive(latest.pid)) continue;
      const failed = this.failRun(row.id, {
        error: latest.status === "starting" ? "workflow worker failed to start" : "worker heartbeat lost",
        errorKind: "heartbeat",
      });
      if (failed.status === "failed" && failed.errorKind === "heartbeat") {
        reaped.push(failed);
      }
    }
    return reaped;
  }

  private insertEventRow(
    input: AppendWorkflowEventInput,
    createdAt: string,
  ): WorkflowEventRecord {
    const payload = parseWorkflowEventPayload(input.type, input.data);
    const dataJson = truncateJson(payload, WORKFLOW_LIMITS.eventDataJsonBytes);
    const next = this.database.sqlite
      .prepare(
        `select coalesce(max(seq), 0) + 1 as next_seq from workflow_events where run_id = ?`,
      )
      .get(input.runId) as { next_seq: number };
    const seq = next.next_seq;
    this.database.sqlite
      .prepare(
        `insert into workflow_events (run_id, seq, type, phase, label, data_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        seq,
        input.type,
        input.phase ?? null,
        input.label ?? null,
        dataJson,
        createdAt,
      );
    this.database.sqlite
      .prepare(`update workflow_runs set updated_at = ? where id = ?`)
      .run(createdAt, input.runId);
    return {
      runId: input.runId,
      seq,
      type: input.type,
      phase: input.phase,
      label: input.label,
      dataJson,
      createdAt,
    };
  }

  close(): void {
    this.database.close();
  }

  private requireRun(id: string): WorkflowRunRecord {
    const run = this.getRun(id);
    if (!run) throw new Error(`Unknown workflow run: ${id}`);
    return run;
  }

  private requireAgentCall(runId: string, callIndex: number): WorkflowAgentCallRecord {
    const call = this.getAgentCall(runId, callIndex);
    if (!call) throw new Error(`Unknown workflow agent call: ${runId}#${callIndex}`);
    return call;
  }
}

export function createWorkflowStore(config: ServerConfig): WorkflowStore {
  return new WorkflowStore(config.stateDir);
}

function rowToRun(row: WorkflowRunRow): WorkflowRunRecord {
  return {
    id: row.id,
    name: row.name,
    source: workflowRunSourceSchema.parse(row.source),
    scriptPath: row.script_path,
    scriptHash: row.script_hash,
    workspaceRoot: row.workspace_root,
    workspaceId: row.workspace_id ?? undefined,
    argsJson: row.args_json,
    status: workflowRunStatusSchema.parse(row.status),
    error: row.error ?? undefined,
    errorKind: (row.error_kind as WorkflowErrorKind | null) ?? undefined,
    resultJson: row.result_json ?? undefined,
    pid: row.pid ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    cancelRequested: row.cancel_requested === "true",
    resumedFromRunId: row.resumed_from_run_id ?? undefined,
    baseSha: row.base_sha ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: WorkflowEventRow): WorkflowEventRecord {
  return {
    runId: row.run_id,
    seq: row.seq,
    type: workflowEventTypeSchema.parse(row.type),
    phase: row.phase ?? undefined,
    label: row.label ?? undefined,
    dataJson: row.data_json,
    createdAt: row.created_at,
  };
}

function rowToAgentCall(row: WorkflowAgentCallRow): WorkflowAgentCallRecord {
  return {
    runId: row.run_id,
    callIndex: row.call_index,
    cacheKey: row.cache_key,
    prompt: row.prompt,
    schemaJson: row.schema_json ?? undefined,
    provider: localAgentProviderSchema.parse(row.provider),
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    profileName: row.profile_name ?? undefined,
    profileFingerprint: row.profile_fingerprint ?? undefined,
    label: row.label ?? undefined,
    phase: row.phase ?? undefined,
    status: workflowAgentCallStatusSchema.parse(row.status),
    fromCache: row.from_cache === "true",
    providerSessionId: row.provider_session_id ?? undefined,
    responseText: row.response_text ?? undefined,
    structuredJson: row.structured_json ?? undefined,
    returnValueJson: row.return_value_json ?? undefined,
    error: row.error ?? undefined,
    errorKind: (row.error_kind as WorkflowErrorKind | null) ?? undefined,
    replayMatch:
      row.replay_match === "same_index"
        ? "same_index"
        : undefined,
    replayedFromRunId: row.replayed_from_run_id ?? undefined,
    replayedFromCallIndex: row.replayed_from_call_index ?? undefined,
    replayReason: row.replay_reason ?? undefined,
    isolation: row.isolation === "worktree" ? "worktree" : "shared",
    worktreePath: row.worktree_path ?? undefined,
    dirty: row.dirty === null ? undefined : row.dirty === "true",
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function assertArgsSize(argsJson: string): void {
  assertTextSize(argsJson, WORKFLOW_LIMITS.argsJsonBytes, "argsJson");
}

function assertResultSize(resultJson: string): void {
  assertTextSize(resultJson, WORKFLOW_LIMITS.resultJsonBytes, "resultJson");
}

function assertTextSize(value: string, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds limit (${bytes} > ${maxBytes} bytes)`);
  }
}

function truncateJson(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = JSON.stringify({ error: "unserializable" });
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = JSON.stringify({ truncated: true });
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8") - 32);
  const slice = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  return JSON.stringify({ truncated: true, preview: slice });
}

function unwrapRunResult(
  result: BetterResult<WorkflowRunRecord, WorkflowRunTransitionError>,
): WorkflowRunRecord {
  if (result.isErr()) throw result.error;
  return result.value;
}
