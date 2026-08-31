import type { WorkflowStore } from "./workflow-store.js";
import type {
  WorkflowAgentActivityKind,
  WorkflowAgentActivityStatus,
} from "./workflow-types.js";

export interface WorkflowAgentUsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  state: "partial" | "final";
}

export interface WorkflowAgentObserver {
  onSession?(providerSessionId: string): void;
  onActivity?(activity: {
    kind: WorkflowAgentActivityKind;
    status: WorkflowAgentActivityStatus;
    label: string;
    detail?: string;
    startedAt?: string;
    completedAt?: string;
  }): void;
  onUsage?(usage: WorkflowAgentUsageSnapshot): void;
}

const USAGE_WRITE_INTERVAL_MS = 5_000;

export function createWorkflowAgentObserver(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
  intervalMs = USAGE_WRITE_INTERVAL_MS,
): WorkflowAgentObserver & { close(): void } {
  const baseline = store.getAgentCall(runId, callIndex)?.usage;
  let lastUsageWrite = 0;
  let pendingUsage: WorkflowAgentUsageSnapshot | undefined;
  let timer: NodeJS.Timeout | undefined;

  const persistUsage = (usage: WorkflowAgentUsageSnapshot): void => {
    pendingUsage = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastUsageWrite = Date.now();
    store.updateAgentUsage(runId, callIndex, {
      inputTokens: sumOptional(baseline?.inputTokens, usage.inputTokens),
      cachedInputTokens: sumOptional(baseline?.cachedInputTokens, usage.cachedInputTokens),
      cacheCreationInputTokens: sumOptional(
        baseline?.cacheCreationInputTokens,
        usage.cacheCreationInputTokens,
      ),
      outputTokens: sumOptional(baseline?.outputTokens, usage.outputTokens),
      totalTokens: (baseline?.totalTokens ?? 0) + usage.totalTokens,
      state: usage.state,
    });
  };

  const scheduleUsage = (): void => {
    if (timer) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastUsageWrite));
    timer = setTimeout(() => {
      if (pendingUsage) persistUsage(pendingUsage);
    }, wait);
    timer.unref();
  };

  return {
    onSession(providerSessionId) {
      store.attachAgentSession(runId, callIndex, providerSessionId);
    },
    onActivity(activity) {
      store.appendAgentActivity({ runId, callIndex, ...activity });
    },
    onUsage(usage) {
      if (usage.state === "final" || Date.now() - lastUsageWrite >= intervalMs) {
        persistUsage(usage);
        return;
      }
      pendingUsage = usage;
      scheduleUsage();
    },
    close() {
      if (pendingUsage) persistUsage(pendingUsage);
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}
