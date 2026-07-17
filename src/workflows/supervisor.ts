import { randomUUID } from "node:crypto";
import { createLocalAgentAdapter } from "../local-agent-adapters.js";
import {
  LocalAgentRunController,
  type LocalAgentEvent,
  type LocalAgentRunHandle,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "../local-agent-runtime.js";
import { isLocalAgentProvider } from "../local-agent-profiles.js";
import type { EffectiveLocalAgentPolicy } from "./policy.js";
import {
  allocateWorkflowWorktree,
  cleanupExpiredWorkflowWorktrees,
  cleanupWorkflowWorktree,
  preserveWorkflowWorktree,
} from "./worktrees.js";
import { WorkflowStore, WorkflowValidationError } from "./store.js";
import type {
  JsonObject,
  JsonValue,
  WorkflowAttemptIdentity,
  WorkflowNodeClaimResult,
  WorkflowSupervisorIdentity,
} from "./types.js";

const DEFAULT_SUPERVISOR_LEASE_MS = 5_000;
const DEFAULT_NODE_LEASE_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_IDLE_MS = 1_000;
const DEFAULT_GLOBAL_CONCURRENCY = 4;
const MAX_GLOBAL_CONCURRENCY = 32;
const MAX_ERROR_CHARS = 16_384;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export type WorkflowHandleFactory = (
  provider: string,
  input: LocalAgentRunInput,
) => Promise<LocalAgentRunHandle>;

export interface WorkflowSupervisorOptions {
  supervisorLeaseMs?: number;
  nodeLeaseMs?: number;
  heartbeatMs?: number;
  idleMs?: number;
  ownerToken?: string;
  ownerPid?: number;
  globalConcurrency?: number;
  handleFactory?: WorkflowHandleFactory;
  worktreeAllocator?: typeof allocateWorkflowWorktree;
}

export async function runWorkflowSupervisor(
  stateDir: string,
  options: WorkflowSupervisorOptions = {},
): Promise<boolean> {
  const store = new WorkflowStore(stateDir);
  const supervisorLeaseMs = options.supervisorLeaseMs ?? DEFAULT_SUPERVISOR_LEASE_MS;
  const nodeLeaseMs = options.nodeLeaseMs ?? DEFAULT_NODE_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const globalConcurrency = options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
  validateSupervisorTiming(supervisorLeaseMs, nodeLeaseMs, heartbeatMs, idleMs, globalConcurrency);
  const acquired = store.acquireSupervisor({
    ownerToken: options.ownerToken ?? randomUUID(),
    ownerPid: options.ownerPid ?? process.pid,
    leaseMs: supervisorLeaseMs,
  });
  if (!acquired) {
    store.close();
    return false;
  }

  const identity: WorkflowSupervisorIdentity = acquired;
  const active = new Set<Promise<void>>();
  let lastWorkAt = Date.now();
  try {
    store.reconcileExpiredClaims();
    store.convergeCancellations();
    await cleanupExpiredWorkflowWorktrees({
      store,
      beforeCleanup: () => store.heartbeatSupervisor(identity, supervisorLeaseMs),
    });
    while (store.heartbeatSupervisor(identity, supervisorLeaseMs)) {
      store.reconcileExpiredClaims();
      store.convergeCancellations();
      let claimed = false;
      while (active.size < globalConcurrency) {
        const claim = store.claimNextAgentNode({
          supervisor: identity,
          claimToken: randomUUID(),
          leaseMs: nodeLeaseMs,
        });
        if (!claim) break;
        claimed = true;
        lastWorkAt = Date.now();
        let execution!: Promise<void>;
        execution = executeClaim(store, identity, claim, {
          supervisorLeaseMs,
          nodeLeaseMs,
          heartbeatMs,
          handleFactory: options.handleFactory ?? defaultHandleFactory,
          worktreeAllocator: options.worktreeAllocator ?? allocateWorkflowWorktree,
        }).finally(() => {
          active.delete(execution);
          lastWorkAt = Date.now();
        });
        active.add(execution);
      }
      if (claimed) continue;

      const supervisor = store.getSupervisor();
      if (!supervisor || supervisor.ownerToken !== identity.ownerToken || supervisor.ownerEpoch !== identity.ownerEpoch) {
        await Promise.allSettled(active);
        return false;
      }
      if (active.size > 0) {
        await Promise.race([...active, delay(heartbeatMs)]);
        continue;
      }
      if (store.hasPendingWork()) {
        await delay(heartbeatMs);
        continue;
      }
      if (Date.now() - lastWorkAt >= idleMs) {
        if (store.releaseSupervisor(identity, supervisor.wakeGeneration)) return true;
        lastWorkAt = Date.now();
        continue;
      }
      await delay(Math.min(heartbeatMs, Math.max(10, idleMs - (Date.now() - lastWorkAt))));
    }
    await Promise.allSettled(active);
    return false;
  } finally {
    store.releaseSupervisor(identity);
    store.close();
  }
}

async function executeClaim(
  store: WorkflowStore,
  supervisor: WorkflowSupervisorIdentity,
  claim: WorkflowNodeClaimResult,
  options: {
    supervisorLeaseMs: number;
    nodeLeaseMs: number;
    heartbeatMs: number;
    handleFactory: WorkflowHandleFactory;
    worktreeAllocator: typeof allocateWorkflowWorktree;
  },
): Promise<void> {
  const identity: WorkflowAttemptIdentity = {
    workflowId: claim.workflow.id,
    nodeKey: claim.node.key,
    attempt: claim.node.attempt,
    claimToken: claim.node.claimToken!,
  };
  const config = claim.node.definition.config ?? {};
  let handle: LocalAgentRunHandle | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let cancellationObserved = false;
  let timeoutObserved = false;
  let worktreeAllocated = false;
  let allocatedWorktreeRoot: string | undefined;
  let completedSuccessfully = false;
  let leaseFailure: Error | undefined;
  let tickRunning = false;

  const tick = async () => {
    if (tickRunning || leaseFailure) return;
    tickRunning = true;
    try {
      if (!store.heartbeatSupervisor(supervisor, options.supervisorLeaseMs)) {
        leaseFailure = new Error("Workflow supervisor lease lost.");
        await handle?.cancel(leaseFailure);
        return;
      }
      if (!store.heartbeatNode({ ...identity, leaseMs: options.nodeLeaseMs })) {
        leaseFailure = new Error("Workflow node claim lost.");
        await handle?.cancel(leaseFailure);
        return;
      }
      if (!cancellationObserved && store.isCancellationRequested(identity.workflowId)) {
        cancellationObserved = true;
        store.markNodeCancelling(identity);
        await handle?.cancel(new Error("Workflow cancellation requested."));
      }
    } finally {
      tickRunning = false;
    }
  };

  try {
    await tick();
    if (leaseFailure) throw leaseFailure;
    heartbeat = setInterval(() => void tick().catch(() => undefined), options.heartbeatMs);

    const execution = readExecutionSnapshot(config);
    const fullPrompt = execution.profileBody
      ? `${execution.profileBody}\n\nTask:\n${execution.prompt}`
      : execution.prompt;
    if (execution.effectivePolicy.access === "workspace_write") {
      const allocation = await options.worktreeAllocator({
        store,
        identity,
        sourceRoot: execution.workspaceRoot,
        worktreeRoot: execution.worktreeRoot,
        baseSha: execution.baseSha,
      });
      execution.workspaceRoot = allocation.path;
      allocatedWorktreeRoot = execution.worktreeRoot;
      worktreeAllocated = true;
    }
    if (!store.markNodeDispatching(identity)) {
      throw new Error("Workflow node attempt was lost before dispatch.");
    }

    handle = await options.handleFactory(execution.provider, {
      prompt: fullPrompt,
      workspace: execution.workspaceRoot,
      model: execution.model,
      thinking: execution.thinking,
      policy: execution.effectivePolicy,
    });
    if (leaseFailure) {
      await handle.cancel(leaseFailure);
      throw leaseFailure;
    }
    if (cancellationObserved) {
      await handle.cancel(new Error("Workflow cancellation requested."));
    }
    if (!store.markNodeRunning(identity)) {
      throw new Error("Workflow node attempt was lost during dispatch.");
    }

    if (execution.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timeoutObserved = true;
        void handle?.cancel(new Error("Workflow node timed out."));
      }, execution.timeoutMs);
    }

    const drain = drainEvents(store, identity, handle);
    let result: LocalAgentRunResult;
    try {
      result = await handle.result();
    } finally {
      await drain;
    }
    if (timeoutObserved) throw new Error("Workflow node timed out.");
    if (result.providerSessionId) {
      store.recordNodeProviderSession(identity, result.providerSessionId);
    }
    const cancelled = cancellationObserved || store.isCancellationRequested(identity.workflowId);
    const completed = store.completeAgentNode({
      ...identity,
      status: cancelled ? "cancelled" : "succeeded",
      result: {
        provider: result.provider,
        providerSessionId: result.providerSessionId,
        finalResponse: result.finalResponse,
      },
    });
    completedSuccessfully = Boolean(completed && !cancelled);
  } catch (error) {
    const cancelled = !timeoutObserved && (
      cancellationObserved || store.isCancellationRequested(identity.workflowId) || isAbortError(error)
    );
    store.completeAgentNode({
      ...identity,
      status: cancelled ? "cancelled" : "failed",
      error: normalizedError(timeoutObserved ? "timed_out" : cancelled ? "cancelled" : "provider_failed", error),
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    await handle?.dispose().catch(() => undefined);
    if (worktreeAllocated) {
      if (completedSuccessfully && allocatedWorktreeRoot) {
        await cleanupWorkflowWorktree({
          store,
          identity,
          worktreeRoot: allocatedWorktreeRoot,
        }).catch(() => undefined);
      } else {
        preserveWorkflowWorktree(store, identity);
      }
    }
    store.convergeCancellations();
  }
}

async function drainEvents(
  store: WorkflowStore,
  identity: WorkflowAttemptIdentity,
  handle: LocalAgentRunHandle,
): Promise<void> {
  for await (const event of handle.events()) {
    if (event.type === "session") {
      store.recordNodeProviderSession(identity, event.providerSessionId);
    }
    try {
      store.appendNodeExecutionEvent({
        identity,
        sourceSequence: event.sequence,
        type: `provider.${event.type}`,
        payload: eventPayload(event),
      });
    } catch (error) {
      if (!(error instanceof WorkflowValidationError)) throw error;
      break;
    }
  }
}

function eventPayload(event: LocalAgentEvent): JsonObject {
  return JSON.parse(JSON.stringify(event)) as JsonObject;
}

function readExecutionSnapshot(config: JsonObject): {
  provider: string;
  model?: string;
  thinking?: string;
  profileBody: string;
  prompt: string;
  workspaceRoot: string;
  worktreeRoot: string;
  baseSha: string;
  timeoutMs?: number;
  effectivePolicy: EffectiveLocalAgentPolicy;
} {
  const provider = requiredString(config.provider, "provider");
  if (!isLocalAgentProvider(provider) && provider !== "fake") {
    throw new Error(`Unsupported workflow provider: ${provider}`);
  }
  const timeoutMs = optionalInteger(config.timeoutMs, "timeoutMs");
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error(`Workflow timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  const policy = config.effectivePolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Workflow execution snapshot is missing effectivePolicy.");
  }
  return {
    provider,
    model: optionalString(config.model),
    thinking: optionalString(config.thinking),
    profileBody: optionalString(config.profileBody) ?? "",
    prompt: requiredString(config.prompt, "prompt"),
    workspaceRoot: requiredString(config.workspaceRoot, "workspaceRoot"),
    worktreeRoot: optionalString(config.worktreeRoot) ?? "",
    baseSha: optionalString(config.baseSha) ?? "",
    timeoutMs,
    effectivePolicy: policy as unknown as EffectiveLocalAgentPolicy,
  };
}

async function defaultHandleFactory(
  provider: string,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunHandle> {
  if (provider === "fake" || process.env.DEVSPACE_WORKFLOW_FAKE_PROVIDER === "1") {
    return createFakeHandle(input);
  }
  if (!isLocalAgentProvider(provider)) throw new Error(`Unsupported workflow provider: ${provider}`);
  return createLocalAgentAdapter(provider).start(input);
}

function createFakeHandle(input: LocalAgentRunInput): LocalAgentRunHandle {
  const controller = new LocalAgentRunController("fake", input.signal);
  const behavior = process.env.DEVSPACE_WORKFLOW_FAKE_BEHAVIOR ?? "success";
  const delayMs = Number(process.env.DEVSPACE_WORKFLOW_FAKE_DELAY_MS ?? "25");
  let timer: NodeJS.Timeout | undefined;
  let finishPump!: () => void;
  const pump = new Promise<void>((resolve) => {
    finishPump = resolve;
    timer = setTimeout(() => {
      controller.emit({ type: "session", providerSessionId: "fake-session", resumed: false });
      controller.emit({ type: "output", stream: "assistant", delta: "fake result" });
      if (behavior === "fail") controller.fail(new Error("Deterministic fake provider failure."));
      else controller.succeed({
        provider: "fake",
        providerSessionId: "fake-session",
        finalResponse: "fake result",
        items: [],
      });
      finishPump();
    }, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 25);
  });
  controller.setLifecycle({
    cancel: () => {
      if (timer) clearTimeout(timer);
      finishPump();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      finishPump();
    },
    pump,
  });
  return controller;
}

function normalizedError(code: string, error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, MAX_ERROR_CHARS) };
}

function requiredString(value: JsonValue | undefined, name: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`Workflow execution snapshot is missing ${name}.`);
  return text;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalInteger(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error(`Workflow ${name} must be an integer.`);
  return value as number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function validateSupervisorTiming(
  supervisorLeaseMs: number,
  nodeLeaseMs: number,
  heartbeatMs: number,
  idleMs: number,
  globalConcurrency: number,
): void {
  for (const [label, value] of [
    ["supervisor lease", supervisorLeaseMs],
    ["node lease", nodeLeaseMs],
    ["heartbeat", heartbeatMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new WorkflowValidationError(`Workflow ${label} must be a positive integer.`);
    }
  }
  if (!Number.isSafeInteger(idleMs) || idleMs < 0) {
    throw new WorkflowValidationError("Workflow supervisor idle timeout must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(globalConcurrency) || globalConcurrency < 1 || globalConcurrency > MAX_GLOBAL_CONCURRENCY) {
    throw new WorkflowValidationError(
      `Workflow global concurrency must be between 1 and ${MAX_GLOBAL_CONCURRENCY}.`,
    );
  }
  if (heartbeatMs >= Math.min(supervisorLeaseMs, nodeLeaseMs)) {
    throw new WorkflowValidationError("Workflow heartbeat interval must be shorter than both leases.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
