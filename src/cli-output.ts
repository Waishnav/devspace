import type {
  WorkflowAgentCallRecord,
  WorkflowRunRecord,
} from "./workflow-types.js";

export function workflowRunOutput(
  run: WorkflowRunRecord,
  calls?: WorkflowAgentCallRecord[],
): Record<string, unknown> {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    source: run.source,
    scriptPath: run.scriptPath,
    resumedFromRunId: run.resumedFromRunId,
    cancelRequested: run.cancelRequested,
    calls: calls ? workflowCallCounts(calls) : undefined,
    result: parseStoredJson(run.resultJson),
    error: run.error
      ? { kind: run.errorKind, message: parseStoredJson(run.error) }
      : undefined,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
  };
}

export function workflowCallOutput(
  call: WorkflowAgentCallRecord,
  options: { detailed?: boolean } = {},
): Record<string, unknown> {
  return {
    index: call.callIndex,
    status: call.status,
    label: call.label,
    phase: call.phase,
    target: call.profileName ?? call.provider,
    provider: call.provider,
    model: call.model,
    effort: call.effort,
    cached: call.fromCache,
    durationMs: workflowCallDurationMs(call),
    isolation: call.isolation,
    worktree: call.worktreePath
      ? { path: call.worktreePath, dirty: call.dirty }
      : undefined,
    error: call.error
      ? { kind: call.errorKind, message: parseStoredJson(call.error) }
      : undefined,
    replay: call.replayedFromRunId
      ? {
          runId: call.replayedFromRunId,
          callIndex: call.replayedFromCallIndex,
        }
      : call.replayReason
        ? { reason: call.replayReason }
        : undefined,
    ...(options.detailed
      ? {
          prompt: call.prompt,
          schema: parseStoredJson(call.schemaJson),
          response: call.responseText,
          structured: parseStoredJson(call.structuredJson),
          result: parseStoredJson(call.returnValueJson),
        }
      : {}),
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    updatedAt: call.updatedAt,
  };
}

function workflowCallCounts(calls: WorkflowAgentCallRecord[]): Record<string, number> {
  return {
    running: calls.filter((call) => call.status === "running").length,
    completed: calls.filter((call) =>
      call.status === "completed" || call.status === "from_cache"
    ).length,
    failed: calls.filter((call) => call.status === "failed").length,
    cancelled: calls.filter((call) => call.status === "cancelled").length,
    total: calls.length,
  };
}

function workflowCallDurationMs(call: WorkflowAgentCallRecord): number | undefined {
  if (!call.startedAt || !call.completedAt) return undefined;
  return Math.max(0, Date.parse(call.completedAt) - Date.parse(call.startedAt));
}

function parseStoredJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
