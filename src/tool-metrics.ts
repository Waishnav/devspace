export interface ToolMetrics {
  serverDurationMs: number;
  payloadCharacters: number;
  returnedItems: number;
  truncated: boolean;
  cacheHit?: boolean;
}

export interface BoundedBuild<T extends object> {
  payload: T;
  returnedItems: number;
  truncated: boolean;
}

export function measuredPayload<T extends object>(
  payload: T,
  input: {
    startedAt: number;
    returnedItems: number;
    truncated: boolean;
    cacheHit?: boolean;
  },
): T & { metrics: ToolMetrics } {
  const metrics: ToolMetrics = {
    serverDurationMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
    payloadCharacters: 0,
    returnedItems: input.returnedItems,
    truncated: input.truncated,
    ...(input.cacheHit === undefined ? {} : { cacheHit: input.cacheHit }),
  };
  const result = { ...payload, metrics };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const characters = JSON.stringify(result).length;
    if (metrics.payloadCharacters === characters) break;
    metrics.payloadCharacters = characters;
  }

  return result;
}

export function buildBoundedPayload<T extends object>(input: {
  startedAt: number;
  maxCharacters: number;
  cacheHit?: boolean;
  build(contentBudget: number): BoundedBuild<T>;
}): T & { metrics: ToolMetrics } {
  let contentBudget = Math.max(0, input.maxCharacters - 512);
  let result: T & { metrics: ToolMetrics };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const built = input.build(contentBudget);
    result = measuredPayload(built.payload, {
      startedAt: input.startedAt,
      returnedItems: built.returnedItems,
      truncated: built.truncated,
      cacheHit: input.cacheHit,
    });
    if (result.metrics.payloadCharacters <= input.maxCharacters) return result;
    contentBudget = Math.max(
      0,
      contentBudget - (result.metrics.payloadCharacters - input.maxCharacters) - 64,
    );
  }

  throw new Error(`Unable to fit tool payload within ${input.maxCharacters} characters.`);
}

export function takeWithinCharacterBudget<T>(
  items: T[],
  budget: number,
): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let used = 2;
  for (const item of items) {
    const characters = JSON.stringify(item).length + (selected.length > 0 ? 1 : 0);
    if (used + characters > budget) return { items: selected, truncated: true };
    selected.push(item);
    used += characters;
  }
  return { items: selected, truncated: false };
}

export function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
