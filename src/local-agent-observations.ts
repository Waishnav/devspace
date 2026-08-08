/** Provider-neutral observations emitted while a local agent is running. */

export const LOCAL_AGENT_TOOL_STATUSES = [
  "started",
  "updated",
  "completed",
  "failed",
] as const;

export type LocalAgentToolStatus = (typeof LOCAL_AGENT_TOOL_STATUSES)[number];

/** Token fields are optional because providers expose different subsets. */
export interface LocalAgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LocalAgentActivityObservation {
  kind: "activity";
  /** Provider operation id, when the provider exposes one. */
  activityId?: string;
  message?: string;
  toolName?: string;
  toolStatus?: LocalAgentToolStatus;
  detail?: string;
}

export interface LocalAgentUsageObservation {
  kind: "usage";
  usage: LocalAgentTokenUsage;
}

export type LocalAgentObservation =
  | LocalAgentActivityObservation
  | LocalAgentUsageObservation;

export function normalizeLocalAgentTokenUsage(value: unknown): LocalAgentTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: LocalAgentTokenUsage = {
    inputTokens: readNonNegativeNumber(record, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
    outputTokens: readNonNegativeNumber(record, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
    totalTokens: readNonNegativeNumber(record, ["totalTokens", "total_tokens"]),
    cacheReadTokens: readNonNegativeNumber(record, ["cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens"]),
    cacheWriteTokens: readNonNegativeNumber(record, ["cacheWriteTokens", "cache_write_tokens"]),
  };
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.values(usage).some((part) => part !== undefined) ? usage : undefined;
}

export function mergeLocalAgentTokenUsage(
  previous: LocalAgentTokenUsage | undefined,
  next: LocalAgentTokenUsage | undefined,
): LocalAgentTokenUsage | undefined {
  if (!previous && !next) return undefined;
  return {
    inputTokens: next?.inputTokens ?? previous?.inputTokens,
    outputTokens: next?.outputTokens ?? previous?.outputTokens,
    totalTokens: next?.totalTokens ?? previous?.totalTokens,
    cacheReadTokens: next?.cacheReadTokens ?? previous?.cacheReadTokens,
    cacheWriteTokens: next?.cacheWriteTokens ?? previous?.cacheWriteTokens,
  };
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    return Math.floor(value);
  }
  return undefined;
}
