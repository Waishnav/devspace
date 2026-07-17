import { createHash, randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { JsonObject, JsonValue, WorkflowWorkspaceScope } from "./types.js";
import { WorkflowIdempotencyConflictError, WorkflowValidationError } from "./store.js";

export type WorkflowRuntimeStatus = "running" | "succeeded" | "failed" | "cancelled";
export type WorkflowRuntimeCallStatus = "pending" | "running" | "succeeded" | "failed";

export interface WorkflowRuntimeMetadata {
  version: 1;
  name?: string;
  description?: string;
}

export interface WorkflowRuntimeBudget {
  maxAgentCalls: number;
  maxConcurrency: number;
  timeoutMs: number;
}

export interface WorkflowRuntimeRun {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  sourceHash: string;
  args: JsonObject;
  metadata: WorkflowRuntimeMetadata;
  budget: WorkflowRuntimeBudget;
  idempotencyKey?: string;
  requestHash: string;
  status: WorkflowRuntimeStatus;
  result?: JsonValue;
  error?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowRuntimeCall {
  runtimeRunId: string;
  callIndex: number;
  requestHash: string;
  request: JsonObject;
  workflowRunId?: string;
  status: WorkflowRuntimeCallStatus;
  result?: JsonValue;
  error?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface RuntimeRunRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  source_hash: string;
  args_json: string;
  metadata_json: string;
  budget_json: string;
  idempotency_key: string | null;
  request_hash: string;
  status: WorkflowRuntimeStatus;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RuntimeCallRow {
  runtime_run_id: string;
  call_index: number;
  request_hash: string;
  request_json: string;
  workflow_run_id: string | null;
  status: WorkflowRuntimeCallStatus;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class WorkflowRuntimeJournal {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  submit(input: {
    sourceHash: string;
    args: JsonObject;
    metadata: WorkflowRuntimeMetadata;
    budget: WorkflowRuntimeBudget;
    workspace: WorkflowWorkspaceScope;
    idempotencyKey?: string;
  }): { run: WorkflowRuntimeRun; created: boolean } {
    const requestHash = hashJson({
      sourceHash: input.sourceHash,
      args: input.args,
      metadata: input.metadata,
      budget: input.budget,
      workspace: input.workspace,
    });
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    const submit = this.database.sqlite.transaction(() => {
      if (idempotencyKey) {
        const existing = this.database.sqlite
          .prepare(
            `select * from workflow_runtime_runs
             where workspace_id = ? and workspace_root = ? and idempotency_key = ?`,
          )
          .get(input.workspace.workspaceId, input.workspace.workspaceRoot, idempotencyKey) as RuntimeRunRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new WorkflowIdempotencyConflictError(idempotencyKey);
          }
          return { run: rowToRun(existing), created: false };
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `insert into workflow_runtime_runs (
             id, workspace_id, workspace_root, source_hash, args_json, metadata_json,
             budget_json, idempotency_key, request_hash, status, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          id,
          input.workspace.workspaceId,
          input.workspace.workspaceRoot,
          input.sourceHash,
          serialize(input.args),
          serialize(input.metadata),
          serialize(input.budget),
          idempotencyKey ?? null,
          requestHash,
          now,
          now,
        );
      return { run: this.require(id), created: true };
    });
    const result = submit.immediate();
    if (result.created) {
      this.appendEvent(result.run.id, "runtime.started", { sourceHash: input.sourceHash });
    }
    return result;
  }

  require(runId: string): WorkflowRuntimeRun {
    const row = this.database.sqlite
      .prepare("select * from workflow_runtime_runs where id = ?")
      .get(runId) as RuntimeRunRow | undefined;
    if (!row) throw new WorkflowValidationError(`Unknown workflow runtime run: ${runId}`);
    return rowToRun(row);
  }

  resume(runId: string): WorkflowRuntimeRun {
    const current = this.require(runId);
    if (current.status === "succeeded") return current;
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `update workflow_runtime_runs
         set status = 'running', result_json = null, error_json = null,
             completed_at = null, updated_at = ? where id = ?`,
      )
      .run(now, runId);
    this.appendEvent(runId, "runtime.resumed", {});
    return this.require(runId);
  }

  beginCall(input: {
    runId: string;
    callIndex: number;
    request: JsonObject;
  }): { call: WorkflowRuntimeCall; replayed: boolean } {
    if (!Number.isSafeInteger(input.callIndex) || input.callIndex < 0) {
      throw new WorkflowValidationError("Workflow runtime call index must be a non-negative integer");
    }
    const requestHash = hashJson(input.request);
    const begin = this.database.sqlite.transaction(() => {
      const existing = this.getCallRow(input.runId, input.callIndex);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new WorkflowValidationError(
            `Workflow runtime replay diverged at agent call ${input.callIndex}`,
          );
        }
        return { call: rowToCall(existing), replayed: true };
      }
      const now = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `insert into workflow_runtime_calls (
             runtime_run_id, call_index, request_hash, request_json, status, created_at, updated_at
           ) values (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(input.runId, input.callIndex, requestHash, serialize(input.request), now, now);
      return { call: rowToCall(this.getCallRow(input.runId, input.callIndex)!), replayed: false };
    });
    const result = begin.immediate();
    if (!result.replayed) {
      this.appendEvent(input.runId, "agent.requested", { callIndex: input.callIndex, requestHash });
    }
    return result;
  }

  markCallRunning(runId: string, callIndex: number, workflowRunId: string): WorkflowRuntimeCall {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update workflow_runtime_calls
         set status = 'running', workflow_run_id = ?, updated_at = ?
         where runtime_run_id = ? and call_index = ? and status in ('pending', 'running')`,
      )
      .run(workflowRunId, now, runId, callIndex);
    if (result.changes !== 1) throw new WorkflowValidationError("Workflow runtime call is not runnable");
    this.appendEvent(runId, "agent.started", { callIndex, workflowRunId });
    return this.requireCall(runId, callIndex);
  }

  completeCall(
    runId: string,
    callIndex: number,
    status: "succeeded" | "failed",
    value: JsonValue | JsonObject,
  ): WorkflowRuntimeCall {
    const now = new Date().toISOString();
    const resultJson = status === "succeeded" ? serialize(value) : null;
    const errorJson = status === "failed" ? serialize(value) : null;
    const result = this.database.sqlite
      .prepare(
        `update workflow_runtime_calls
         set status = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
         where runtime_run_id = ? and call_index = ? and status in ('pending', 'running')`,
      )
      .run(status, resultJson, errorJson, now, now, runId, callIndex);
    if (result.changes !== 1) {
      const current = this.requireCall(runId, callIndex);
      if (current.status === status) return current;
      throw new WorkflowValidationError("Workflow runtime call is already terminal");
    }
    this.appendEvent(runId, `agent.${status}`, { callIndex });
    return this.requireCall(runId, callIndex);
  }

  requireCall(runId: string, callIndex: number): WorkflowRuntimeCall {
    const row = this.getCallRow(runId, callIndex);
    if (!row) throw new WorkflowValidationError(`Unknown workflow runtime call: ${callIndex}`);
    return rowToCall(row);
  }

  appendEvent(runId: string, eventType: string, payload: JsonObject): number {
    const append = this.database.sqlite.transaction(() => {
      this.require(runId);
      const row = this.database.sqlite
        .prepare(
          "select coalesce(max(sequence), 0) + 1 as sequence from workflow_runtime_events where runtime_run_id = ?",
        )
        .get(runId) as { sequence: number };
      this.database.sqlite
        .prepare(
          `insert into workflow_runtime_events
           (runtime_run_id, sequence, event_type, payload_json, created_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(runId, row.sequence, eventType, serialize(payload), new Date().toISOString());
      return row.sequence;
    });
    return append.immediate();
  }

  completeRun(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    value: JsonValue | JsonObject,
  ): WorkflowRuntimeRun {
    const now = new Date().toISOString();
    const resultJson = status === "succeeded" ? serialize(value) : null;
    const errorJson = status === "succeeded" ? null : serialize(value);
    const updated = this.database.sqlite
      .prepare(
        `update workflow_runtime_runs
         set status = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
         where id = ? and status = 'running'`,
      )
      .run(status, resultJson, errorJson, now, now, runId);
    if (updated.changes !== 1) {
      const current = this.require(runId);
      if (current.status === status) return current;
      throw new WorkflowValidationError("Workflow runtime run is already terminal");
    }
    this.appendEvent(runId, `runtime.${status}`, {});
    return this.require(runId);
  }

  close(): void {
    this.database.close();
  }

  private getCallRow(runId: string, callIndex: number): RuntimeCallRow | undefined {
    return this.database.sqlite
      .prepare(
        "select * from workflow_runtime_calls where runtime_run_id = ? and call_index = ?",
      )
      .get(runId, callIndex) as RuntimeCallRow | undefined;
  }
}

export function workflowRuntimeSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function rowToRun(row: RuntimeRunRow): WorkflowRuntimeRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    sourceHash: row.source_hash,
    args: parseJson<JsonObject>(row.args_json),
    metadata: parseJson<WorkflowRuntimeMetadata>(row.metadata_json),
    budget: parseJson<WorkflowRuntimeBudget>(row.budget_json),
    idempotencyKey: row.idempotency_key ?? undefined,
    requestHash: row.request_hash,
    status: row.status,
    result: parseOptional(row.result_json),
    error: parseOptional(row.error_json) as JsonObject | undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToCall(row: RuntimeCallRow): WorkflowRuntimeCall {
  return {
    runtimeRunId: row.runtime_run_id,
    callIndex: row.call_index,
    requestHash: row.request_hash,
    request: parseJson<JsonObject>(row.request_json),
    workflowRunId: row.workflow_run_id ?? undefined,
    status: row.status,
    result: parseOptional(row.result_json),
    error: parseOptional(row.error_json) as JsonObject | undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parseOptional(value: string | null): JsonValue | undefined {
  return value === null ? undefined : parseJson<JsonValue>(value);
}
