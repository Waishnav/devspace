import type { ServerConfig } from "./config.js";
import { terminateProcessTree } from "./process-platform.js";
import {
  createWorkflowStore,
  type WorkflowStore,
} from "./workflow-store.js";
import {
  WORKFLOW_CANCEL_HARD_MS,
  WORKFLOW_HEARTBEAT_MS,
  type WorkflowRunRecord,
} from "./workflow-types.js";

const DEFAULT_TERM_WAIT_MS = 1_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_REAPER_INTERVAL_MS = WORKFLOW_HEARTBEAT_MS * 2;
const DEFAULT_STALE_AFTER_MS = WORKFLOW_HEARTBEAT_MS * 3;

const ACTIVE_STATUSES = new Set(["starting", "running"]);

export interface WorkflowLifecycleRuntime {
  sleep(ms: number): Promise<void>;
  terminate(pid: number, signal: NodeJS.Signals): void;
}

const defaultRuntime: WorkflowLifecycleRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  terminate: (pid, signal) => {
    terminateProcessTree(
      {
        pid,
        kill: (requestedSignal = signal) => {
          try {
            process.kill(pid, requestedSignal);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            throw error;
          }
        },
      },
      signal,
      true,
    );
  },
};

export interface CancelWorkflowRunOptions {
  graceMs?: number;
  termWaitMs?: number;
  pollMs?: number;
  runtime?: WorkflowLifecycleRuntime;
}

/**
 * Shared CLI/MCP cancellation path: cooperative flag, grace period, process
 * tree termination, then an atomic terminal fallback in the journal.
 */
export async function cancelWorkflowRun(
  store: WorkflowStore,
  runId: string,
  options: CancelWorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
  const requested = store.requestCancelResult(runId);
  if (requested.isErr()) throw requested.error;
  if (!isActive(requested.value)) return requested.value;

  const runtime = options.runtime ?? defaultRuntime;
  const graceMs = Math.max(0, options.graceMs ?? WORKFLOW_CANCEL_HARD_MS);
  const termWaitMs = Math.max(0, options.termWaitMs ?? DEFAULT_TERM_WAIT_MS);
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);

  const cooperative = await waitForTerminal(store, runId, graceMs, pollMs, runtime);
  if (cooperative && !isActive(cooperative)) return cooperative;

  let current = store.getRun(runId);
  if (!current) throw new Error(`Unknown workflow run: ${runId}`);
  if (!isActive(current)) return current;

  if (current.pid) {
    safelyTerminate(runtime, current.pid, "SIGTERM");
    const afterTerm = await waitForTerminal(store, runId, termWaitMs, pollMs, runtime);
    if (afterTerm && !isActive(afterTerm)) return afterTerm;

    current = store.getRun(runId) ?? current;
    if (isActive(current) && current.pid) {
      safelyTerminate(runtime, current.pid, "SIGKILL");
    }
  }

  const cancelled = store.cancelRunResult(runId, "cancelled by workflow supervisor");
  if (cancelled.isErr()) throw cancelled.error;
  return cancelled.value;
}

export function reapStaleWorkflows(
  store: WorkflowStore,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): WorkflowRunRecord[] {
  return store.reapStale(staleAfterMs);
}

export interface WorkflowReaperHandle {
  close(): void;
}

export function startWorkflowReaper(
  config: ServerConfig,
  options: {
    intervalMs?: number;
    staleAfterMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): WorkflowReaperHandle {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS);
  const staleAfterMs = Math.max(1, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);

  const tick = (): void => {
    let store: WorkflowStore | undefined;
    try {
      store = createWorkflowStore(config);
      reapStaleWorkflows(store, staleAfterMs);
    } catch (error) {
      options.onError?.(error);
    } finally {
      store?.close();
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    close(): void {
      clearInterval(timer);
    },
  };
}

async function waitForTerminal(
  store: WorkflowStore,
  runId: string,
  waitMs: number,
  pollMs: number,
  runtime: WorkflowLifecycleRuntime,
): Promise<WorkflowRunRecord | undefined> {
  const deadline = Date.now() + waitMs;
  let current = store.getRun(runId);
  while (current && isActive(current) && Date.now() < deadline) {
    await runtime.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    current = store.getRun(runId);
  }
  return current;
}

function safelyTerminate(
  runtime: WorkflowLifecycleRuntime,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    runtime.terminate(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isActive(run: WorkflowRunRecord): boolean {
  return ACTIVE_STATUSES.has(run.status);
}
