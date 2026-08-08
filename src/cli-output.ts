import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type {
  WorkflowAgentCallRecord,
  WorkflowRunRecord,
} from "./workflow-types.js";

export function localAgentTargetsOutput(catalog: LocalAgentCatalog): Record<string, unknown> {
  return {
    profiles: catalog.profiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
    })),
    providers: catalog.providers.map((provider) => ({
      name: provider.name,
      overrides: [
        ...(provider.model.supported ? ["model"] : []),
        ...(provider.effort.supported ? ["effort"] : []),
      ],
    })),
  };
}

export function localAgentOutput(
  agent: LocalAgentRecord,
  options: { includeResult?: boolean } = {},
): Record<string, unknown> {
  return {
    id: agent.id,
    status: agent.status,
    target: agent.profileName,
    provider: agent.provider,
    model: agent.model,
    effort: agent.effort,
    ...(options.includeResult
      ? { response: agent.latestResponse, error: agent.error }
      : {}),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

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
    usage: calls ? sumUsage(calls.map((call) => call.finalUsage ?? call.usage)) : undefined,
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
    usage: call.finalUsage ?? call.usage,
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

function sumUsage(calls: Array<WorkflowAgentCallRecord["usage"]>): WorkflowAgentCallRecord["usage"] | undefined {
  const result: NonNullable<WorkflowAgentCallRecord["usage"]> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const values = calls
      .map((usage) => usage?.[key])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) result[key] = values.reduce((total, value) => total + value, 0);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseStoredJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
