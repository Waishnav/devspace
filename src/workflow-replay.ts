import type { WorkflowAgentCallRecord } from "./workflow-types.js";
import type { WorkflowReplay, WorkflowReplayHit } from "./workflow-api.js";

/**
 * Resume matcher:
 * 1. Prefer same callIndex + cacheKey
 * 2. On first miss for an index, fall back to consume-once by cacheKey
 *    (handles fan-out reordering vs prior run).
 */
export function createWorkflowReplay(
  priorCalls: WorkflowAgentCallRecord[],
): WorkflowReplay {
  const byIndex = new Map<number, WorkflowAgentCallRecord>();
  const byKeyQueue = new Map<string, WorkflowAgentCallRecord[]>();

  for (const call of priorCalls) {
    if (call.status !== "completed" && call.status !== "from_cache") continue;
    byIndex.set(call.callIndex, call);
    const queue = byKeyQueue.get(call.cacheKey) ?? [];
    queue.push(call);
    byKeyQueue.set(call.cacheKey, queue);
  }

  const consumed = new Set<string>(); // `${callIndex}` of prior rows consumed

  return {
    match(callIndex: number, cacheKey: string): WorkflowReplayHit | null {
      const exact = byIndex.get(callIndex);
      if (exact && exact.cacheKey === cacheKey && !consumed.has(indexKey(exact))) {
        consumed.add(indexKey(exact));
        removeFromKeyQueue(byKeyQueue, exact);
        return toHit(exact);
      }

      const queue = byKeyQueue.get(cacheKey);
      if (!queue || queue.length === 0) return null;
      const next = queue.shift()!;
      consumed.add(indexKey(next));
      if (queue.length === 0) byKeyQueue.delete(cacheKey);
      return toHit(next);
    },
  };
}

function indexKey(call: WorkflowAgentCallRecord): string {
  return `${call.runId}:${call.callIndex}`;
}

function removeFromKeyQueue(
  map: Map<string, WorkflowAgentCallRecord[]>,
  call: WorkflowAgentCallRecord,
): void {
  const queue = map.get(call.cacheKey);
  if (!queue) return;
  const idx = queue.findIndex(
    (row) => row.runId === call.runId && row.callIndex === call.callIndex,
  );
  if (idx >= 0) queue.splice(idx, 1);
  if (queue.length === 0) map.delete(call.cacheKey);
}

function toHit(call: WorkflowAgentCallRecord): WorkflowReplayHit {
  if (call.structuredJson) {
    try {
      return {
        value: JSON.parse(call.structuredJson),
        responseText: call.responseText,
        structuredJson: call.structuredJson,
        providerSessionId: call.providerSessionId,
      };
    } catch {
      // fall through to text
    }
  }
  return {
    value: call.responseText ?? "",
    responseText: call.responseText,
    structuredJson: call.structuredJson,
    providerSessionId: call.providerSessionId,
  };
}
