import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAgentRunController, type LocalAgentRunHandle } from "../local-agent-runtime.js";
import { ensureSupervisor } from "./supervisor-launch.js";
import { runWorkflowSupervisor } from "./supervisor.js";
import { WorkflowStore } from "./store.js";
import type { JsonObject, SubmitWorkflowRequest } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "devspace-supervisor-test-"));
try {
  await testExecutionAndEventReplay(join(root, "execution"));
  await testDuplicateSupervisorPrevention(join(root, "singleton"));
  await testStaleSupervisorProcessRecovery(join(root, "stale-supervisor"));
  await testAtomicClaimAndLeaseRecovery(join(root, "claims"));
  await testDispatchHeartbeatsProtectLeases(join(root, "dispatch-heartbeats"));
  await testCancellationBeforeAndDuringExecution(join(root, "cancellation"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function testExecutionAndEventReplay(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const snapshot = executionSnapshot({ profileBody: "Original profile" });
  const submitted = store.submit(workflowRequest(snapshot)).workflow;
  snapshot.profileBody = "Mutated after submit";
  store.close();

  const ran = await runWorkflowSupervisor(stateDir, {
    idleMs: 20,
    heartbeatMs: 5,
    supervisorLeaseMs: 100,
    nodeLeaseMs: 100,
    handleFactory: successfulHandleFactory,
  });
  assert.equal(ran, true);

  const reader = new WorkflowStore(stateDir);
  try {
    const workflow = reader.require(submitted.id);
    assert.equal(workflow.status, "succeeded");
    assert.equal(workflow.nodes[0]!.attempt, 1);
    assert.equal(workflow.nodes[0]!.definition.config!.profileBody, "Original profile");
    assert.equal((workflow.result as JsonObject).finalResponse, "completed");
    const first = reader.readEvents(workflow.id, { after: 0, limit: 4 });
    const second = reader.readEvents(workflow.id, { after: first.nextCursor, limit: 100 });
    assert.ok(second.events.some((event) => event.type === "provider.session"));
    assert.ok(second.events.some((event) => event.type === "provider.output"));
    assert.deepEqual(
      [...first.events, ...second.events].map((event) => event.sequence),
      Array.from({ length: first.events.length + second.events.length }, (_, index) => index + 1),
    );
  } finally {
    reader.close();
  }
}

async function testDuplicateSupervisorPrevention(stateDir: string): Promise<void> {
  const owner = new WorkflowStore(stateDir);
  const acquired = owner.acquireSupervisor({ ownerToken: "owner", ownerPid: 1, leaseMs: 1_000 });
  assert.ok(acquired);
  assert.equal(await runWorkflowSupervisor(stateDir, { ownerToken: "other", idleMs: 5 }), false);
  assert.equal(owner.getSupervisor()!.ownerToken, "owner");
  owner.releaseSupervisor(acquired!);
  owner.close();
}

async function testStaleSupervisorProcessRecovery(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const stale = store.acquireSupervisor({
    ownerToken: "stale-owner",
    ownerPid: 2_147_483_647,
    leaseMs: 60_000,
  })!;
  store.close();

  const launched = await ensureSupervisor({
    stateDir,
    cliEntrypoint: fileURLToPath(new URL("../cli.ts", import.meta.url)),
    env: process.env,
    startupTimeoutMs: 2_000,
  });
  assert.equal(launched.spawned, true);
  assert.ok((launched.ownerEpoch ?? 0) > stale.ownerEpoch);

  const cleanup = new WorkflowStore(stateDir);
  const current = cleanup.getSupervisor();
  if (current) cleanup.releaseSupervisor(current);
  cleanup.close();
}

async function testAtomicClaimAndLeaseRecovery(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const first = store.submit(workflowRequest(executionSnapshot())).workflow;
  const supervisor = store.acquireSupervisor({ ownerToken: "claims", ownerPid: 2, leaseMs: 1_000 })!;
  const claim = store.claimNextAgentNode({ supervisor, claimToken: "first", leaseMs: 30 });
  assert.equal(claim?.workflow.id, first.id);
  assert.equal(
    store.claimNextAgentNode({ supervisor, claimToken: "duplicate", leaseMs: 30 }),
    undefined,
  );
  await delay(10);
  assert.ok(store.heartbeatNode({
    workflowId: first.id,
    nodeKey: "agent",
    attempt: 1,
    claimToken: "first",
    leaseMs: 30,
  }));
  await delay(15);
  assert.equal(store.reconcileExpiredClaims(), 0);
  await delay(25);
  assert.equal(store.reconcileExpiredClaims(), 1);
  const failed = store.require(first.id);
  assert.equal(failed.status, "failed");
  assert.equal((failed.error as JsonObject).code, "worker_lost");
  assert.equal(failed.nodes[0]!.attempt, 1, "worker loss must not retry by default");

  const parallel = store.submit({
    definition: {
      version: 1,
      nodes: [
        { key: "first", type: "agent", config: executionSnapshot() },
        { key: "second", type: "agent", config: executionSnapshot() },
      ],
      edges: [],
    },
  }).workflow;
  store.claimNode({ workflowId: parallel.id, nodeKey: "first", claimToken: "parallel-first", leaseMs: 10 });
  store.claimNode({ workflowId: parallel.id, nodeKey: "second", claimToken: "parallel-second", leaseMs: 10 });
  await delay(20);
  assert.equal(store.reconcileExpiredClaims(), 1);
  assert.deepEqual(
    store.require(parallel.id).nodes.map((node) => node.status).sort(),
    ["cancelled", "failed"],
  );
  store.releaseSupervisor(supervisor);
  store.close();
}

async function testDispatchHeartbeatsProtectLeases(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const workflow = store.submit(workflowRequest(executionSnapshot())).workflow;
  store.close();

  const ran = await runWorkflowSupervisor(stateDir, {
    idleMs: 20,
    heartbeatMs: 5,
    supervisorLeaseMs: 40,
    nodeLeaseMs: 40,
    handleFactory: async () => {
      await delay(90);
      return successfulHandleFactory();
    },
  });
  assert.equal(ran, true);

  const reader = new WorkflowStore(stateDir);
  try {
    assert.equal(reader.require(workflow.id).status, "succeeded");
  } finally {
    reader.close();
  }
}

async function testCancellationBeforeAndDuringExecution(stateDir: string): Promise<void> {
  const beforeStore = new WorkflowStore(stateDir);
  const before = beforeStore.submit(workflowRequest(executionSnapshot())).workflow;
  beforeStore.requestCancellation(before.id);
  beforeStore.close();
  let starts = 0;
  await runWorkflowSupervisor(stateDir, {
    idleMs: 20,
    heartbeatMs: 5,
    supervisorLeaseMs: 100,
    nodeLeaseMs: 100,
    handleFactory: async (...args) => {
      starts += 1;
      return successfulHandleFactory();
    },
  });
  const afterBefore = new WorkflowStore(stateDir);
  assert.equal(afterBefore.require(before.id).status, "cancelled");
  assert.equal(starts, 0);

  const during = afterBefore.submit(workflowRequest(executionSnapshot())).workflow;
  afterBefore.close();
  const supervisorPromise = runWorkflowSupervisor(stateDir, {
    idleMs: 20,
    heartbeatMs: 5,
    supervisorLeaseMs: 100,
    nodeLeaseMs: 100,
    handleFactory: delayedHandleFactory,
  });
  await waitForStatus(stateDir, during.id, "running");
  const canceller = new WorkflowStore(stateDir);
  canceller.requestCancellation(during.id);
  canceller.requestSupervisorWake();
  canceller.close();
  await supervisorPromise;
  const finalStore = new WorkflowStore(stateDir);
  try {
    assert.equal(finalStore.require(during.id).status, "cancelled");
    assert.equal(finalStore.require(during.id).nodes[0]!.status, "cancelled");
  } finally {
    finalStore.close();
  }
}

async function successfulHandleFactory(): Promise<LocalAgentRunHandle> {
  return completedHandle(5);
}

async function delayedHandleFactory(): Promise<LocalAgentRunHandle> {
  return completedHandle(500);
}

function completedHandle(delayMs: number): LocalAgentRunHandle {
  const controller = new LocalAgentRunController("fake");
  let timer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const pump = new Promise<void>((resolve) => {
    finish = resolve;
    timer = setTimeout(() => {
      controller.emit({ type: "session", providerSessionId: "session-1", resumed: false });
      controller.emit({ type: "output", stream: "assistant", delta: "completed" });
      controller.succeed({
        provider: "fake",
        providerSessionId: "session-1",
        finalResponse: "completed",
        items: [],
      });
      finish();
    }, delayMs);
  });
  controller.setLifecycle({
    cancel: () => {
      if (timer) clearTimeout(timer);
      finish();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      finish();
    },
    pump,
  });
  return controller;
}

function workflowRequest(config: JsonObject): SubmitWorkflowRequest {
  return {
    definition: { version: 1, nodes: [{ key: "agent", type: "agent", config }], edges: [] },
    workspace: { workspaceId: "workspace", workspaceRoot: "/tmp/workspace" },
  };
}

function executionSnapshot(overrides: JsonObject = {}): JsonObject {
  return {
    profileBody: "",
    profileName: "fake",
    profileHash: "hash",
    provider: "fake",
    model: null,
    thinking: null,
    effectivePolicy: {
      version: 1,
      mode: "workflow",
      access: "read_only",
      environment: {},
    },
    workspaceRoot: "/tmp/workspace",
    prompt: "task",
    timeoutMs: null,
    environmentPolicy: {},
    ...overrides,
  };
}

async function waitForStatus(stateDir: string, workflowId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const store = new WorkflowStore(stateDir);
    const current = store.require(workflowId).status;
    store.close();
    if (current === status) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${workflowId} to become ${status}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
