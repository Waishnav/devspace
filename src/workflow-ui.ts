import type { JsonValue } from "./json-types.js";
import type { WorkflowStore } from "./workflow-store.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  buildWorkflowRunView,
  loadWorkflowProjectView,
  type WorkflowCallCounts,
  type WorkflowProjectView,
  type WorkflowRunView,
} from "./workflow-view.js";

export interface WorkflowRunSummaryView {
  id: string;
  name: string;
  status: WorkflowRunView["status"];
  currentPhase?: string;
  calls: WorkflowCallCounts;
  updatedAt: string;
}

export interface WorkflowCallDetailView {
  runId: string;
  callIndex: number;
  status: string;
  provider: string;
  model?: string;
  effort?: string;
  label?: string;
  phase?: string;
  prompt: string;
  schema?: JsonValue | string;
  responseText?: string;
  structured?: JsonValue | string;
  error?: string;
  errorKind?: string;
  providerSessionId?: string;
  isolation: "shared" | "worktree";
  worktreePath?: string;
  dirty?: boolean;
  fromCache: boolean;
  replayMatch?: "same_index";
  replayedFromRunId?: string;
  replayedFromCallIndex?: number;
  replayReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export function loadActiveWorkflowSummaries(
  store: WorkflowStore,
  workspaceRoot: string,
): WorkflowRunSummaryView[] {
  return loadWorkflowProjectView(store, workspaceRoot, {
    statuses: [...ACTIVE_WORKFLOW_STATUSES],
    limit: 50,
    eventLimit: 50,
  }).runs.map(summarizeWorkflowRun);
}

export function loadWorkflowUiProject(
  store: WorkflowStore,
  workspaceRoot: string,
): WorkflowProjectView {
  return loadWorkflowProjectView(store, workspaceRoot, {
    statuses: [...ACTIVE_WORKFLOW_STATUSES],
    limit: 50,
    eventLimit: 100,
  });
}

export function loadWorkflowUiRun(
  store: WorkflowStore,
  runId: string,
): WorkflowRunView | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  return buildWorkflowRunView(
    run,
    store.listAgentCalls(run.id),
    store.listEvents(run.id, 100),
  );
}

export function loadWorkflowUiCallDetail(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
): WorkflowCallDetailView | undefined {
  const call = store.getAgentCall(runId, callIndex);
  if (!call) return undefined;
  return {
    runId,
    callIndex,
    status: call.status,
    provider: call.provider,
    model: call.model,
    effort: call.effort,
    label: call.label,
    phase: call.phase,
    prompt: call.prompt,
    schema: parseStoredJson(call.schemaJson),
    responseText: call.responseText,
    structured: parseStoredJson(call.structuredJson),
    error: call.error,
    errorKind: call.errorKind,
    providerSessionId: call.providerSessionId,
    isolation: call.isolation,
    worktreePath: call.worktreePath,
    dirty: call.dirty,
    fromCache: call.fromCache,
    replayMatch: call.replayMatch,
    replayedFromRunId: call.replayedFromRunId,
    replayedFromCallIndex: call.replayedFromCallIndex,
    replayReason: call.replayReason,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    updatedAt: call.updatedAt,
  };
}

export function summarizeWorkflowRun(run: WorkflowRunView): WorkflowRunSummaryView {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    currentPhase: run.currentPhase,
    calls: run.calls,
    updatedAt: run.updatedAt,
  };
}

function parseStoredJson(value: string | undefined): JsonValue | string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}
