import { performance } from "node:perf_hooks";
import type {
  SubmitWorkflowRequest,
  WorkflowEventPage,
  WorkflowEventReadOptions,
  WorkflowRunRecord,
  WorkflowWaitOptions,
} from "./types.js";
import { WorkflowStore, WorkflowValidationError } from "./store.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 1_000;

export class WorkflowOrchestrator {
  private readonly store: WorkflowStore;
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(stateDir: string) {
    this.store = new WorkflowStore(stateDir);
  }

  submit(request: SubmitWorkflowRequest): WorkflowRunRecord {
    const workflow = this.store.submit(request).workflow;
    this.notify(workflow.id);
    return workflow;
  }

  get(workflowId: string): WorkflowRunRecord | undefined {
    return this.store.get(workflowId);
  }

  async wait(workflowId: string, options: WorkflowWaitOptions = {}): Promise<WorkflowRunRecord> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    validateWaitOptions(timeoutMs, pollIntervalMs);

    let workflow = this.store.require(workflowId);
    if (isTerminal(workflow) || timeoutMs === 0) return workflow;

    const deadline = performance.now() + timeoutMs;
    while (!isTerminal(workflow)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return workflow;
      await this.waitForPollOrNotification(
        workflowId,
        Math.min(remaining, pollIntervalMs),
      );
      if (this.closed) return workflow;
      workflow = this.store.require(workflowId);
    }
    return workflow;
  }

  events(workflowId: string, options: WorkflowEventReadOptions = {}): WorkflowEventPage {
    return this.store.readEvents(workflowId, options);
  }

  cancel(workflowId: string): WorkflowRunRecord {
    const workflow = this.store.requestCancellation(workflowId);
    this.notify(workflowId);
    return workflow;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const callbacks of this.waiters.values()) {
      for (const callback of callbacks) callback();
    }
    this.waiters.clear();
    this.store.close();
  }

  private waitForPollOrNotification(workflowId: string, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const callbacks = this.waiters.get(workflowId) ?? new Set<() => void>();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callbacks.delete(finish);
        if (callbacks.size === 0) this.waiters.delete(workflowId);
        resolve();
      };
      callbacks.add(finish);
      this.waiters.set(workflowId, callbacks);
      const timer = setTimeout(finish, delayMs);
    });
  }

  private notify(workflowId: string): void {
    const callbacks = this.waiters.get(workflowId);
    if (!callbacks) return;
    for (const callback of [...callbacks]) callback();
  }
}

function validateWaitOptions(timeoutMs: number, pollIntervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new WorkflowValidationError(
      `Workflow wait timeout must be between 0 and ${MAX_WAIT_TIMEOUT_MS} milliseconds`,
    );
  }
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new WorkflowValidationError(
      `Workflow wait poll interval must be between 1 and ${MAX_POLL_INTERVAL_MS} milliseconds`,
    );
  }
}

function isTerminal(workflow: WorkflowRunRecord): boolean {
  return (
    workflow.status === "succeeded" ||
    workflow.status === "failed" ||
    workflow.status === "cancelled"
  );
}
