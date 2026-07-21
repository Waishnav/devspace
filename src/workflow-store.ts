import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import {
  WORKFLOW_LIMITS,
  type AgentIsolationMode,
  type WorkflowAgentCallRecord,
  type WorkflowAgentCallStatus,
  type WorkflowErrorKind,
  type WorkflowEventRecord,
  type WorkflowEventType,
  type WorkflowRunRecord,
  type WorkflowRunSource,
  type WorkflowRunStatus,
} from "./workflow-types.js";

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

export interface AppendWorkflowEventInput {
  runId: string;
  type: WorkflowEventType;
  phase?: string;
  label?: string;
  data?: unknown;
}

export interface BeginAgentCallInput {
  runId: string;
  callIndex: number;
  cacheKey: string;
  provider: string;
  model?: string;
  effort?: string;
  label?: string;
  phase?: string;
  isolation?: AgentIsolationMode;
  worktreePath?: string;
}

export interface CompleteAgentCallInput {
  runId: string;
  callIndex: number;
  responseText?: string;
  structuredJson?: string;
  providerSessionId?: string;
  dirty?: boolean;
  worktreePath?: string;
  fromCache?: boolean;
}

export interface FailAgentCallInput {
  runId: string;
  callIndex: number;
  error: string;
  worktreePath?: string;
  dirty?: boolean;
}

export interface CompleteRunInput {
  resultJson?: string;
}

export interface FailRunInput {
  error: string;
  errorKind?: WorkflowErrorKind;
}

export interface DrainEventsResult {
  events: WorkflowEventRecord[];
  nextSeq: number;
  terminal: boolean;
  run: WorkflowRunRecord;
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
  provider: string;
  model: string | null;
  effort: string | null;
  label: string | null;
  phase: string | null;
  status: string;
  from_cache: string;
  provider_session_id: string | null;
  response_text: string | null;
  structured_json: string | null;
  error: string | null;
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

  listRuns(limit = 50): WorkflowRunRecord[] {
    const rows = this.database.sqlite
      .prepare("select * from workflow_runs order by updated_at desc limit ?")
      .all(Math.max(1, Math.min(limit, 500))) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Atomically claim a starting run for the worker.
   * Returns undefined if the run is missing or not claimable.
   */
  setScriptPath(id: string, scriptPath: string): WorkflowRunRecord {
    this.requireRun(id);
    const now = isoNow();
    this.database.sqlite
      .prepare(
        `UPDATE workflow_runs SET script_path = ?, updated_at = ? WHERE id = ?`,
      )
      .run(scriptPath, now, id);
    return this.requireRun(id);
  }

  claimRun(id: string, pid: number): WorkflowRunRecord | undefined {
    const now = isoNow();
    const result = this.database.sqlite
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
    if (result.changes === 0) return undefined;
    return this.getRun(id);
  }

  setHeartbeat(id: string, at = isoNow()): void {
    this.database.sqlite
      .prepare(
        `update workflow_runs set heartbeat_at = ?, updated_at = ? where id = ? and status = 'running'`,
      )
      .run(at, at, id);
  }

  requestCancel(id: string): WorkflowRunRecord {
    const run = this.requireRun(id);
    if (TERMINAL_STATUSES.has(run.status)) return run;

    const now = isoNow();
    this.database.sqlite
      .prepare(
        `update workflow_runs set cancel_requested = 'true', updated_at = ? where id = ?`,
      )
      .run(now, id);
    return this.requireRun(id);
  }

  isCancelRequested(id: string): boolean {
    return this.requireRun(id).cancelRequested;
  }

  completeRun(id: string, input: CompleteRunInput = {}): WorkflowRunRecord {
    if (input.resultJson !== undefined) assertResultSize(input.resultJson);
    const now = isoNow();
    const result = this.database.sqlite
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
      .run(input.resultJson ?? null, now, now, id);
    if (result.changes === 0) {
      const run = this.requireRun(id);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      throw new Error(`Cannot complete workflow run ${id} in status ${run.status}`);
    }
    return this.requireRun(id);
  }

  failRun(id: string, input: FailRunInput): WorkflowRunRecord {
    const now = isoNow();
    const result = this.database.sqlite
      .prepare(
        `update workflow_runs set
          status = 'failed',
          error = ?,
          error_kind = ?,
          completed_at = ?,
          updated_at = ?
         where id = ? and status in ('starting', 'running')`,
      )
      .run(input.error, input.errorKind ?? "internal", now, now, id);
    if (result.changes === 0) {
      const run = this.requireRun(id);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      throw new Error(`Cannot fail workflow run ${id} in status ${run.status}`);
    }
    return this.requireRun(id);
  }

  cancelRun(id: string, error = "cancelled"): WorkflowRunRecord {
    const now = isoNow();
    const result = this.database.sqlite
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
      .run(error, now, now, id);
    if (result.changes === 0) {
      const run = this.requireRun(id);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      throw new Error(`Cannot cancel workflow run ${id} in status ${run.status}`);
    }
    return this.requireRun(id);
  }

  appendEvent(input: AppendWorkflowEventInput): WorkflowEventRecord {
    const dataJson = truncateJson(input.data ?? {}, WORKFLOW_LIMITS.eventDataJsonBytes);
    const createdAt = isoNow();

    const insert = this.database.sqlite.transaction(() => {
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
      return seq;
    });

    const seq = insert();
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
      .all(runId, sinceSeq, capped) as WorkflowEventRow[];
    const events = rows.map(rowToEvent);
    const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : sinceSeq;
    return {
      events,
      nextSeq,
      terminal: TERMINAL_STATUSES.has(run.status),
      run,
    };
  }

  beginAgentCall(input: BeginAgentCallInput): WorkflowAgentCallRecord {
    const now = isoNow();
    const isolation: AgentIsolationMode = input.isolation === "worktree" ? "worktree" : "shared";
    this.database.sqlite
      .prepare(
        `insert into workflow_agent_calls (
          run_id, call_index, cache_key, provider, model, effort, label, phase,
          status, from_cache, isolation, worktree_path, created_at, started_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'false', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.callIndex,
        input.cacheKey,
        input.provider,
        input.model ?? null,
        input.effort ?? null,
        input.label ?? null,
        input.phase ?? null,
        isolation,
        input.worktreePath ?? null,
        now,
        now,
        now,
      );
    return this.requireAgentCall(input.runId, input.callIndex);
  }

  completeAgentCall(input: CompleteAgentCallInput): WorkflowAgentCallRecord {
    if (input.responseText !== undefined) {
      assertTextSize(input.responseText, WORKFLOW_LIMITS.responseTextBytes, "responseText");
    }
    if (input.structuredJson !== undefined) {
      assertTextSize(input.structuredJson, WORKFLOW_LIMITS.structuredJsonBytes, "structuredJson");
    }
    const now = isoNow();
    const status: WorkflowAgentCallStatus = input.fromCache ? "from_cache" : "completed";
    this.database.sqlite
      .prepare(
        `update workflow_agent_calls set
          status = ?,
          from_cache = ?,
          response_text = ?,
          structured_json = ?,
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
    this.database.sqlite
      .prepare(
        `update workflow_agent_calls set
          status = 'failed',
          error = ?,
          worktree_path = coalesce(?, worktree_path),
          dirty = ?,
          completed_at = ?,
          updated_at = ?
         where run_id = ? and call_index = ?`,
      )
      .run(
        input.error,
        input.worktreePath ?? null,
        input.dirty === undefined ? null : input.dirty ? "true" : "false",
        now,
        now,
        input.runId,
        input.callIndex,
      );
    return this.requireAgentCall(input.runId, input.callIndex);
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
   * Mark running runs with a dead worker as failed.
   * staleBeforeMs: heartbeat older than this AND pid not alive.
   */
  reapStale(staleBeforeMs = 60_000, nowMs = Date.now()): WorkflowRunRecord[] {
    const cutoff = new Date(nowMs - staleBeforeMs).toISOString();
    const candidates = this.database.sqlite
      .prepare(
        `select * from workflow_runs
         where status = 'running'
           and heartbeat_at is not null
           and heartbeat_at < ?`,
      )
      .all(cutoff) as WorkflowRunRow[];

    const reaped: WorkflowRunRecord[] = [];
    for (const row of candidates) {
      if (row.pid !== null && isPidAlive(row.pid)) continue;
      reaped.push(
        this.failRun(row.id, {
          error: "worker heartbeat lost",
          errorKind: "heartbeat",
        }),
      );
    }
    return reaped;
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
    source: row.source as WorkflowRunSource,
    scriptPath: row.script_path,
    scriptHash: row.script_hash,
    workspaceRoot: row.workspace_root,
    workspaceId: row.workspace_id ?? undefined,
    argsJson: row.args_json,
    status: row.status as WorkflowRunStatus,
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
    type: row.type as WorkflowEventType,
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
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    label: row.label ?? undefined,
    phase: row.phase ?? undefined,
    status: row.status as WorkflowAgentCallStatus,
    fromCache: row.from_cache === "true",
    providerSessionId: row.provider_session_id ?? undefined,
    responseText: row.response_text ?? undefined,
    structuredJson: row.structured_json ?? undefined,
    error: row.error ?? undefined,
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
  } catch {
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
