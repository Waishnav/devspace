import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type WorkflowState =
  | "starting" | "running" | "pausing" | "paused"
  | "waiting_for_permission" | "waiting_for_usage"
  | "stopping" | "stopped" | "completed" | "failed"
  | "recovery_required";

export type WorkflowStepState =
  | "queued" | "starting" | "running" | "waiting_for_permission"
  | "waiting_for_usage" | "completed" | "failed" | "stopped"
  | "cached" | "uncertain";

export interface WorkflowError {
  code: string;
  message: string;
  layer: "script" | "workflow" | "workspace" | "adapter" | "provider";
  retryable: boolean;
  runId?: string;
  stepId?: string;
  agentId?: string;
  provider?: string;
  location?: { line: number; column: number };
}

export interface WorkflowRunRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  lineageId: string;
  budgetId: string;
  resumedFromRunId?: string;
  state: WorkflowState;
  meta: JsonObject;
  scriptSource: string;
  scriptHash: string;
  sourcePath?: string;
  argsPresent: boolean;
  args?: JsonValue;
  defaults: JsonObject;
  policy: JsonObject;
  runtimeVersion: string;
  revision: number;
  executionGeneration: number;
  result?: JsonValue;
  resultArtifactId?: string;
  error?: WorkflowError;
  pauseReason?: string;
  nextEligibleAt?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface WorkflowBudgetRecord {
  id: string;
  totalOutputTokens: number | null;
  knownOutputTokens: number;
  usageComplete: boolean;
  revision: number;
}

export interface WorkflowStepRecord {
  id: string;
  runId: string;
  parentStepId?: string;
  kind: "agent" | "workflow";
  callSequence: number;
  logicalPath: string;
  requestHash: string;
  request: JsonObject;
  phase?: string;
  label?: string;
  state: WorkflowStepState;
  agentId?: string;
  workspaceId: string;
  cachedFromStepId?: string;
  output?: JsonValue;
  error?: WorkflowError;
  deliverySequence?: number;
  worktree?: JsonObject;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface WorkflowStepSummary {
  id: string;
  kind: "agent" | "workflow";
  label?: string;
  workspaceId: string;
  phase?: string;
  state: WorkflowStepState;
  worktree?: JsonObject;
}

export type WorkflowAttemptState = Exclude<WorkflowStepState, "cached">;
export type WorkflowAttemptReason = "initial" | "schema_repair" | "restart" | "retry";

export interface WorkflowAttemptRecord {
  id: string;
  stepId: string;
  attemptNumber: number;
  agentId: string;
  agentTurnId: number;
  reason: WorkflowAttemptReason;
  state: WorkflowAttemptState;
  usageSequence: number;
  outputTokens?: number;
  usageComplete: boolean;
  error?: WorkflowError;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface WorkflowEventRecord {
  runId: string;
  sequence: number;
  stepId?: string;
  type: string;
  payload: JsonObject;
  createdAt: string;
}

export interface CreateWorkflowRunInput {
  id?: string;
  workspaceId: string;
  workspaceRoot: string;
  meta: JsonObject;
  scriptSource: string;
  scriptHash: string;
  sourcePath?: string;
  argsPresent: boolean;
  args?: JsonValue;
  defaults: JsonObject;
  policy: JsonObject;
  runtimeVersion: string;
  outputTokenBudget?: number;
}

export interface CreateWorkflowStepInput {
  id?: string;
  runId: string;
  parentStepId?: string;
  kind: "agent" | "workflow";
  logicalPath: string;
  requestHash: string;
  request: JsonObject;
  phase?: string;
  label?: string;
  workspaceId: string;
  cachedFromStepId?: string;
  output?: JsonValue;
  worktree?: JsonObject;
}

interface RunRow {
  id: string; workspace_id: string; workspace_root: string; lineage_id: string; budget_id: string;
  resumed_from_run_id: string | null; state: string; meta_json: string; script_source: string;
  script_hash: string; source_path: string | null; args_present: number; args_json: string | null;
  defaults_json: string; policy_json: string; runtime_version: string; revision: number;
  execution_generation: number; result_json: string | null; result_artifact_id: string | null;
  error_json: string | null; pause_reason: string | null; next_eligible_at: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}

interface StepRow {
  id: string; run_id: string; parent_step_id: string | null; kind: string; call_sequence: number;
  logical_path: string; request_hash: string; request_json: string; phase: string | null;
  label: string | null; status: string; agent_id: string | null; workspace_id: string;
  cached_from_step_id: string | null; output_json: string | null; error_json: string | null;
  delivery_sequence: number | null; worktree_json: string | null; created_at: string;
  updated_at: string; finished_at: string | null;
}

interface AttemptRow {
  id: string; step_id: string; attempt_number: number; agent_id: string; agent_turn_id: number;
  reason: string; state: string; usage_sequence: number; output_tokens: number | null;
  usage_complete: number; error_json: string | null; created_at: string; updated_at: string;
  finished_at: string | null;
}

interface EventRow {
  run_id: string; sequence: number; step_id: string | null; type: string;
  payload_json: string; created_at: string;
}

/** Canonical workflow journal. Every guest-visible delivery is persisted here first. */
export class WorkflowStore {
  private readonly database: DatabaseHandle;
  private readonly ownsDatabase: boolean;

  constructor(stateDirOrDatabase: string | DatabaseHandle) {
    this.database = typeof stateDirOrDatabase === "string" ? openDatabase(stateDirOrDatabase) : stateDirOrDatabase;
    this.ownsDatabase = typeof stateDirOrDatabase === "string";
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }

  createRun(input: CreateWorkflowRunInput): WorkflowRunRecord {
    const id = input.id ?? workflowId("wf");
    const budgetId = workflowId("wfb");
    const now = new Date().toISOString();
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        "insert into workflow_budgets (id, total_output_tokens, known_output_tokens, usage_complete, revision) values (?, ?, 0, 1, 0)",
      ).run(budgetId, input.outputTokenBudget ?? null);
      this.insertRun({ ...input, id }, {
        lineageId: id,
        budgetId,
        state: "starting",
        executionGeneration: 1,
        now,
      });
      this.insertEvent(id, 1, undefined, "run_state", { state: "starting" }, now);
    }).immediate();
    return required(this.getRun(id), `Created workflow run ${id} disappeared.`);
  }

  createResumedRun(input: CreateWorkflowRunInput & { sourceRunId: string }): WorkflowRunRecord {
    const id = input.id ?? workflowId("wf");
    const now = new Date().toISOString();
    this.database.sqlite.transaction(() => {
      const source = required(this.getRun(input.sourceRunId), `Unknown workflow run: ${input.sourceRunId}`);
      if (source.workspaceId !== input.workspaceId || source.workspaceRoot !== resolve(input.workspaceRoot)) {
        throw new Error("RESUME_SCOPE_MISMATCH");
      }
      if (!isTerminal(source.state)) throw new Error("WORKFLOW_BUSY");
      if (source.runtimeVersion !== input.runtimeVersion) throw new Error("RESUME_RUNTIME_INCOMPATIBLE");
      this.insertRun({ ...input, id }, {
        lineageId: source.lineageId,
        budgetId: source.budgetId,
        resumedFromRunId: source.id,
        state: "starting",
        executionGeneration: source.executionGeneration + 1,
        now,
      });
      this.database.sqlite.prepare(
        "insert into workflow_resume_claims (source_run_id, source_generation, resumed_by_run_id, created_at) values (?, ?, ?, ?)",
      ).run(source.id, source.executionGeneration, id, now);
      this.insertEvent(id, 1, undefined, "run_state", { state: "starting", resumedFromRunId: source.id }, now);
    }).immediate();
    return required(this.getRun(id), `Created workflow run ${id} disappeared.`);
  }

  private insertRun(
    input: CreateWorkflowRunInput & { id: string },
    derived: {
      lineageId: string; budgetId: string; resumedFromRunId?: string; state: WorkflowState;
      executionGeneration: number; now: string;
    },
  ): void {
    this.database.sqlite.prepare(`insert into workflow_runs (
      id, workspace_id, workspace_root, lineage_id, budget_id, resumed_from_run_id, state,
      meta_json, script_source, script_hash, source_path, args_present, args_json, defaults_json,
      policy_json, runtime_version, revision, execution_generation, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(
        input.id, input.workspaceId, resolve(input.workspaceRoot), derived.lineageId, derived.budgetId,
        derived.resumedFromRunId ?? null, derived.state, json(input.meta), input.scriptSource,
        input.scriptHash, input.sourcePath ?? null, Number(input.argsPresent),
        input.argsPresent ? json(input.args ?? null) : null, json(input.defaults), json(input.policy),
        input.runtimeVersion, derived.executionGeneration, derived.now, derived.now,
      );
  }

  getRun(id: string): WorkflowRunRecord | undefined {
    const row = this.database.sqlite.prepare("select * from workflow_runs where id = ?").get(id) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  getRunForWorkspace(id: string, workspaceId: string): WorkflowRunRecord | undefined {
    const run = this.getRun(id);
    return run?.workspaceId === workspaceId ? run : undefined;
  }

  listRuns(workspaceId: string, limit = 20, before?: { updatedAt: string; id: string }): WorkflowRunRecord[] {
    const rows = before
      ? this.database.sqlite.prepare(`select * from workflow_runs where workspace_id = ?
          and (updated_at < ? or (updated_at = ? and id < ?))
          order by updated_at desc, id desc limit ?`)
        .all(workspaceId, before.updatedAt, before.updatedAt, before.id, limit)
      : this.database.sqlite.prepare(
        "select * from workflow_runs where workspace_id = ? order by updated_at desc, id desc limit ?",
      ).all(workspaceId, limit);
    return (rows as RunRow[]).map(runFromRow);
  }

  listLiveRuns(): WorkflowRunRecord[] {
    return (this.database.sqlite.prepare(`select * from workflow_runs where state not in
      ('completed', 'failed', 'stopped', 'recovery_required') order by created_at`).all() as RunRow[])
      .map(runFromRow);
  }

  transitionRun(
    runId: string,
    state: WorkflowState,
    options: { expected?: readonly WorkflowState[]; reason?: string; error?: WorkflowError; result?: JsonValue; omittedResult?: boolean } = {},
  ): WorkflowRunRecord {
    return this.database.sqlite.transaction(() => {
      const run = required(this.getRun(runId), `Unknown workflow run: ${runId}`);
      if (options.expected && !options.expected.includes(run.state)) throw new Error("WORKFLOW_BUSY");
      const now = new Date().toISOString();
      const terminal = isTerminal(state);
      const resultJson = Object.hasOwn(options, "result") ? json(options.result ?? null) : null;
      const revision = run.revision + 1;
      this.database.sqlite.prepare(`update workflow_runs set state = ?, revision = ?, updated_at = ?,
        finished_at = ?, result_json = coalesce(?, result_json), error_json = coalesce(?, error_json),
        pause_reason = ? where id = ?`)
        .run(state, revision, now, terminal ? now : null, resultJson,
          options.error ? json(options.error) : null, state === "paused" ? options.reason ?? null : null, runId);
      this.insertEvent(runId, revision, undefined, "run_state", {
        state,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.omittedResult ? { omittedResult: true } : {}),
      }, now);
      return required(this.getRun(runId), `Workflow run ${runId} disappeared.`);
    }).immediate();
  }

  appendEvent(runId: string, type: string, payload: JsonObject, stepId?: string): WorkflowEventRecord {
    return this.database.sqlite.transaction(() => {
      const run = required(this.getRun(runId), `Unknown workflow run: ${runId}`);
      const sequence = run.revision + 1;
      const now = new Date().toISOString();
      this.database.sqlite.prepare("update workflow_runs set revision = ?, updated_at = ? where id = ?")
        .run(sequence, now, runId);
      this.insertEvent(runId, sequence, stepId, type, payload, now);
      return { runId, sequence, stepId, type, payload, createdAt: now };
    }).immediate();
  }

  setNextEligibleAt(runId: string, nextEligibleAt?: string): void {
    this.database.sqlite.transaction(() => {
      const run = required(this.getRun(runId), `Unknown workflow run: ${runId}`);
      const sequence = run.revision + 1;
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`update workflow_runs set next_eligible_at = ?, revision = ?, updated_at = ?
        where id = ?`).run(nextEligibleAt ?? null, sequence, now, runId);
      this.insertEvent(runId, sequence, undefined, "usage_gate",
        nextEligibleAt ? { nextEligibleAt } : { cleared: true }, now);
    }).immediate();
  }

  private insertEvent(
    runId: string, sequence: number, stepId: string | undefined, type: string, payload: JsonObject, now: string,
  ): void {
    this.database.sqlite.prepare(
      "insert into workflow_events (run_id, sequence, step_id, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)",
    ).run(runId, sequence, stepId ?? null, type, json(payload), now);
  }

  listEvents(runId: string, afterSequence = 0, limit = 1_000): WorkflowEventRecord[] {
    return (this.database.sqlite.prepare(
      "select * from workflow_events where run_id = ? and sequence > ? order by sequence limit ?",
    ).all(runId, afterSequence, limit) as EventRow[]).map(eventFromRow);
  }

  hasPartialExecution(runId: string): boolean {
    return Boolean(this.database.sqlite.prepare(`select 1 from workflow_events
      where run_id = ? and (type = 'combinator_error'
        or (type = 'warning' and json_extract(payload_json, '$.code') = 'PARTIAL_EXECUTION'))
      limit 1`).get(runId));
  }

  createStep(input: CreateWorkflowStepInput): WorkflowStepRecord {
    return this.database.sqlite.transaction(() => {
      const run = required(this.getRun(input.runId), `Unknown workflow run: ${input.runId}`);
      const stepId = input.id ?? workflowId("wfs");
      const callSequence = (this.database.sqlite.prepare(
        "select coalesce(max(call_sequence), 0) + 1 as value from workflow_steps where run_id = ?",
      ).get(input.runId) as { value: number }).value;
      const state: WorkflowStepState = input.cachedFromStepId ? "cached" : "queued";
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`insert into workflow_steps (
        id, run_id, parent_step_id, kind, call_sequence, logical_path, request_hash, request_json,
        phase, label, status, workspace_id, cached_from_step_id, output_json, worktree_json,
        created_at, updated_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(stepId, input.runId, input.parentStepId ?? null, input.kind, callSequence,
          input.logicalPath, input.requestHash, json(input.request), input.phase ?? null,
          input.label ?? null, state, input.workspaceId, input.cachedFromStepId ?? null,
          Object.hasOwn(input, "output") ? json(input.output ?? null) : null,
          input.worktree ? json(input.worktree) : null, now, now, state === "cached" ? now : null);
      const revision = run.revision + 1;
      this.database.sqlite.prepare("update workflow_runs set revision = ?, updated_at = ? where id = ?")
        .run(revision, now, input.runId);
      this.insertEvent(input.runId, revision, stepId, "step_state", { state }, now);
      return required(this.getStep(stepId), `Created workflow step ${stepId} disappeared.`);
    }).immediate();
  }

  getStep(id: string): WorkflowStepRecord | undefined {
    const row = this.database.sqlite.prepare("select * from workflow_steps where id = ?").get(id) as StepRow | undefined;
    return row ? stepFromRow(row) : undefined;
  }

  listSteps(runId: string): WorkflowStepRecord[] {
    return (this.database.sqlite.prepare(
      "select * from workflow_steps where run_id = ? order by call_sequence",
    ).all(runId) as StepRow[]).map(stepFromRow);
  }

  listStepSummaries(runId: string): WorkflowStepSummary[] {
    return (this.database.sqlite.prepare(
      `select id, kind, label, workspace_id, phase, status, worktree_json
        from workflow_steps where run_id = ? order by call_sequence`,
    ).all(runId) as Array<{ id: string; kind: string; label: string | null; workspace_id: string;
      phase: string | null; status: string; worktree_json: string | null }>).map((row) => ({
      id: row.id,
      kind: row.kind as "agent" | "workflow",
      ...(row.label ? { label: row.label } : {}),
      workspaceId: row.workspace_id,
      ...(row.phase ? { phase: row.phase } : {}),
      state: row.status as WorkflowStepState,
      ...(row.worktree_json ? { worktree: parse(row.worktree_json) as JsonObject } : {}),
    }));
  }

  updateStepWorktree(stepId: string, worktree: JsonObject): void {
    this.database.sqlite.transaction(() => {
      const step = required(this.getStep(stepId), `Unknown workflow step: ${stepId}`);
      const run = required(this.getRun(step.runId), `Unknown workflow run: ${step.runId}`);
      const sequence = run.revision + 1;
      const now = new Date().toISOString();
      this.database.sqlite.prepare(
        "update workflow_steps set worktree_json = ?, updated_at = ? where id = ?",
      ).run(json(worktree), now, stepId);
      this.database.sqlite.prepare("update workflow_runs set revision = ?, updated_at = ? where id = ?")
        .run(sequence, now, run.id);
      this.insertEvent(run.id, sequence, stepId, "worktree", worktree, now);
    }).immediate();
  }

  setResultArtifactId(runId: string, artifactId: string): void {
    this.database.sqlite.prepare(
      "update workflow_runs set result_artifact_id = ? where id = ? and result_artifact_id is null",
    ).run(artifactId, runId);
  }

  findReplayPrefix(sourceRunId: string): WorkflowStepRecord[] {
    const rows = this.listSteps(sourceRunId);
    const boundary = rows.findIndex((step) => !["completed", "cached"].includes(step.state));
    return boundary < 0 ? rows : rows.slice(0, boundary);
  }

  transitionStep(
    stepId: string,
    state: WorkflowStepState,
    patch: { agentId?: string; output?: JsonValue; error?: WorkflowError; deliverySequence?: number; worktree?: JsonObject } = {},
  ): WorkflowStepRecord {
    return this.database.sqlite.transaction(() => {
      const step = required(this.getStep(stepId), `Unknown workflow step: ${stepId}`);
      const run = required(this.getRun(step.runId), `Unknown workflow run: ${step.runId}`);
      const now = new Date().toISOString();
      const terminal = isStepTerminal(state);
      this.database.sqlite.prepare(`update workflow_steps set status = ?, agent_id = coalesce(?, agent_id),
        output_json = coalesce(?, output_json), error_json = coalesce(?, error_json),
        delivery_sequence = coalesce(?, delivery_sequence), worktree_json = coalesce(?, worktree_json),
        updated_at = ?, finished_at = ? where id = ?`)
        .run(state, patch.agentId ?? null,
          Object.hasOwn(patch, "output") ? json(patch.output ?? null) : null,
          patch.error ? json(patch.error) : null, patch.deliverySequence ?? null,
          patch.worktree ? json(patch.worktree) : null, now, terminal ? now : null, stepId);
      const revision = run.revision + 1;
      this.database.sqlite.prepare("update workflow_runs set revision = ?, updated_at = ? where id = ?")
        .run(revision, now, run.id);
      this.insertEvent(run.id, revision, stepId, "step_state", { state }, now);
      return required(this.getStep(stepId), `Workflow step ${stepId} disappeared.`);
    }).immediate();
  }

  recordDelivery(stepId: string, deliverySequence: number): WorkflowStepRecord {
    this.database.sqlite.prepare(
      "update workflow_steps set delivery_sequence = ?, updated_at = ? where id = ? and delivery_sequence is null",
    ).run(deliverySequence, new Date().toISOString(), stepId);
    return required(this.getStep(stepId), `Unknown workflow step: ${stepId}`);
  }

  createAttempt(input: {
    id?: string; stepId: string; agentId: string; agentTurnId: number; reason: WorkflowAttemptReason;
  }): WorkflowAttemptRecord {
    const attemptId = input.id ?? workflowId("wfa");
    const now = new Date().toISOString();
    const attemptNumber = (this.database.sqlite.prepare(
      "select coalesce(max(attempt_number), 0) + 1 as value from workflow_attempts where step_id = ?",
    ).get(input.stepId) as { value: number }).value;
    this.database.sqlite.prepare(`insert into workflow_attempts (
      id, step_id, attempt_number, agent_id, agent_turn_id, reason, state, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'starting', ?, ?)`)
      .run(attemptId, input.stepId, attemptNumber, input.agentId, input.agentTurnId, input.reason, now, now);
    return required(this.getAttempt(attemptId), `Created workflow attempt ${attemptId} disappeared.`);
  }

  getAttempt(id: string): WorkflowAttemptRecord | undefined {
    const row = this.database.sqlite.prepare("select * from workflow_attempts where id = ?").get(id) as AttemptRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  listAttempts(stepId: string): WorkflowAttemptRecord[] {
    return (this.database.sqlite.prepare(
      "select * from workflow_attempts where step_id = ? order by attempt_number",
    ).all(stepId) as AttemptRow[]).map(attemptFromRow);
  }

  listAttemptsForRun(runId: string): WorkflowAttemptRecord[] {
    return (this.database.sqlite.prepare(`select a.* from workflow_attempts a
      join workflow_steps s on s.id = a.step_id where s.run_id = ?
      order by s.call_sequence, a.attempt_number`).all(runId) as AttemptRow[]).map(attemptFromRow);
  }

  countAttempts(runId: string): number {
    return (this.database.sqlite.prepare(`select count(*) as count from workflow_attempts a
      join workflow_steps s on s.id = a.step_id where s.run_id = ?`).get(runId) as { count: number }).count;
  }

  transitionAttempt(id: string, state: WorkflowAttemptState, error?: WorkflowError): WorkflowAttemptRecord {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(`update workflow_attempts set state = ?, error_json = coalesce(?, error_json),
      updated_at = ?, finished_at = ? where id = ?`)
      .run(state, error ? json(error) : null, now, isAttemptTerminal(state) ? now : null, id);
    return required(this.getAttempt(id), `Unknown workflow attempt: ${id}`);
  }

  finishAttemptAndStep(
    attemptId: string,
    attemptState: Extract<WorkflowAttemptState, "completed" | "failed" | "stopped" | "uncertain">,
    stepState: Extract<WorkflowStepState, "completed" | "failed" | "stopped" | "uncertain">,
    patch: { output?: JsonValue; error?: WorkflowError } = {},
  ): WorkflowStepRecord {
    return this.database.sqlite.transaction(() => {
      const attempt = this.transitionAttempt(attemptId, attemptState, patch.error);
      return this.transitionStep(attempt.stepId, stepState, patch);
    }).immediate();
  }

  recordUsage(input: {
    attemptId: string; sequence: number; outputTokens?: number; complete: boolean;
  }): WorkflowBudgetRecord {
    return this.database.sqlite.transaction(() => {
      const attempt = required(this.getAttempt(input.attemptId), `Unknown workflow attempt: ${input.attemptId}`);
      const step = required(this.getStep(attempt.stepId), `Unknown workflow step: ${attempt.stepId}`);
      const run = required(this.getRun(step.runId), `Unknown workflow run: ${step.runId}`);
      if (input.sequence <= attempt.usageSequence) return this.getBudget(run.budgetId);
      const previous = attempt.outputTokens ?? 0;
      const next = input.outputTokens;
      if (next !== undefined && next < previous) throw new Error("Usage output tokens cannot decrease.");
      this.database.sqlite.prepare(`update workflow_attempts set usage_sequence = ?, output_tokens = ?,
        usage_complete = ?, updated_at = ? where id = ?`)
        .run(input.sequence, next ?? null, Number(input.complete), new Date().toISOString(), input.attemptId);
      this.database.sqlite.prepare(`update workflow_budgets set
        known_output_tokens = known_output_tokens + ?,
        usage_complete = usage_complete and ?, revision = revision + 1 where id = ?`)
        .run(next === undefined ? 0 : next - previous, Number(next !== undefined), run.budgetId);
      return this.getBudget(run.budgetId);
    }).immediate();
  }

  getBudget(id: string): WorkflowBudgetRecord {
    const row = required(this.database.sqlite.prepare("select * from workflow_budgets where id = ?").get(id) as {
      id: string; total_output_tokens: number | null; known_output_tokens: number;
      usage_complete: number; revision: number;
    } | undefined, `Unknown workflow budget: ${id}`);
    return {
      id: row.id,
      totalOutputTokens: row.total_output_tokens,
      knownOutputTokens: row.known_output_tokens,
      usageComplete: Boolean(row.usage_complete),
      revision: row.revision,
    };
  }

  markActiveAttemptsUncertain(message = "Daemon restarted while the provider attempt was active."): number {
    return this.database.sqlite.transaction(() => {
      const liveRunIds = (this.database.sqlite.prepare(`select id from workflow_runs where state not in
        ('completed', 'failed', 'stopped', 'recovery_required')`).all() as Array<{ id: string }>).map((row) => row.id);
      const active = this.database.sqlite.prepare(`select a.id, s.id as step_id, s.run_id
        from workflow_attempts a join workflow_steps s on s.id = a.step_id
        where a.state in ('queued', 'starting', 'running', 'waiting_for_permission', 'waiting_for_usage')`)
        .all() as Array<{ id: string; step_id: string; run_id: string }>;
      for (const item of active) {
        const error: WorkflowError = { code: "RECOVERY_REQUIRED", message, layer: "workflow", retryable: false };
        this.database.sqlite.prepare(
          "update workflow_attempts set state = 'uncertain', error_json = ?, updated_at = ? where id = ?",
        ).run(json(error), new Date().toISOString(), item.id);
        this.database.sqlite.prepare(
          "update workflow_steps set status = 'uncertain', error_json = ?, updated_at = ? where id = ?",
        ).run(json(error), new Date().toISOString(), item.step_id);
      }
      for (const runId of liveRunIds) {
        const error: WorkflowError = { code: "RECOVERY_REQUIRED", message, layer: "workflow", retryable: false };
        this.transitionRun(runId, "recovery_required", { error });
      }
      return liveRunIds.length;
    }).immediate();
  }

  countSteps(runId: string): Record<"requested" | "queued" | "running" | "completed" | "failed" | "stopped" | "cached", number> {
    const counts = { requested: 0, queued: 0, running: 0, completed: 0, failed: 0, stopped: 0, cached: 0 };
    const rows = this.database.sqlite.prepare(
      "select status, count(*) as count from workflow_steps where run_id = ? group by status",
    ).all(runId) as Array<{ status: WorkflowStepState; count: number }>;
    for (const row of rows) {
      counts.requested += row.count;
      if (row.status in counts) counts[row.status as keyof typeof counts] += row.count;
      else if (["starting", "running", "waiting_for_permission", "waiting_for_usage"].includes(row.status)) counts.running += row.count;
      else if (row.status === "uncertain") counts.failed += row.count;
    }
    return counts;
  }
}

function runFromRow(row: RunRow): WorkflowRunRecord {
  return compact({
    id: row.id, workspaceId: row.workspace_id, workspaceRoot: row.workspace_root,
    lineageId: row.lineage_id, budgetId: row.budget_id,
    resumedFromRunId: row.resumed_from_run_id ?? undefined, state: row.state as WorkflowState,
    meta: parse(row.meta_json), scriptSource: row.script_source, scriptHash: row.script_hash,
    sourcePath: row.source_path ?? undefined, argsPresent: Boolean(row.args_present),
    args: row.args_present ? parse(row.args_json!) : undefined, defaults: parse(row.defaults_json),
    policy: parse(row.policy_json), runtimeVersion: row.runtime_version, revision: row.revision,
    executionGeneration: row.execution_generation,
    result: row.result_json === null ? undefined : parse(row.result_json),
    resultArtifactId: row.result_artifact_id ?? undefined,
    error: row.error_json === null ? undefined : parse(row.error_json),
    pauseReason: row.pause_reason ?? undefined, nextEligibleAt: row.next_eligible_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at ?? undefined,
  }) as unknown as WorkflowRunRecord;
}

function stepFromRow(row: StepRow): WorkflowStepRecord {
  return compact({
    id: row.id, runId: row.run_id, parentStepId: row.parent_step_id ?? undefined,
    kind: row.kind as "agent" | "workflow", callSequence: row.call_sequence,
    logicalPath: row.logical_path, requestHash: row.request_hash, request: parse(row.request_json),
    phase: row.phase ?? undefined, label: row.label ?? undefined, state: row.status as WorkflowStepState,
    agentId: row.agent_id ?? undefined, workspaceId: row.workspace_id,
    cachedFromStepId: row.cached_from_step_id ?? undefined,
    output: row.output_json === null ? undefined : parse(row.output_json),
    error: row.error_json === null ? undefined : parse(row.error_json),
    deliverySequence: row.delivery_sequence ?? undefined,
    worktree: row.worktree_json === null ? undefined : parse(row.worktree_json),
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at ?? undefined,
  }) as unknown as WorkflowStepRecord;
}

function attemptFromRow(row: AttemptRow): WorkflowAttemptRecord {
  return compact({
    id: row.id, stepId: row.step_id, attemptNumber: row.attempt_number, agentId: row.agent_id,
    agentTurnId: row.agent_turn_id, reason: row.reason as WorkflowAttemptReason,
    state: row.state as WorkflowAttemptState, usageSequence: row.usage_sequence,
    outputTokens: row.output_tokens ?? undefined, usageComplete: Boolean(row.usage_complete),
    error: row.error_json === null ? undefined : parse(row.error_json), createdAt: row.created_at,
    updatedAt: row.updated_at, finishedAt: row.finished_at ?? undefined,
  }) as unknown as WorkflowAttemptRecord;
}

function eventFromRow(row: EventRow): WorkflowEventRecord {
  return compact({ runId: row.run_id, sequence: row.sequence, stepId: row.step_id ?? undefined,
    type: row.type, payload: parse(row.payload_json), createdAt: row.created_at }) as unknown as WorkflowEventRecord;
}

function isTerminal(state: WorkflowState): boolean {
  return ["completed", "failed", "stopped", "recovery_required"].includes(state);
}

function isStepTerminal(state: WorkflowStepState): boolean {
  return ["completed", "failed", "stopped", "cached", "uncertain"].includes(state);
}

function isAttemptTerminal(state: WorkflowAttemptState): boolean {
  return ["completed", "failed", "stopped", "uncertain"].includes(state);
}

function workflowId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function json(value: unknown): string { return JSON.stringify(value); }
function parse(value: string): any { return JSON.parse(value); }
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value; }
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
