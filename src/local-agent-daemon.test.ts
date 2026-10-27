import assert from "node:assert/strict";
import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  daemonExecArgv,
  localAgentDaemonEnvironment,
  LocalAgentClient,
} from "./local-agent-client.js";
import {
  LocalAgentDaemon,
  type LocalAgentDaemonManager,
  type LocalAgentDaemonWorkflowManager,
} from "./local-agent-daemon.js";
import {
  ensureLocalAgentDaemonSecret,
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  LocalAgentDaemonLock,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import {
  encodeLocalAgentDaemonResponse,
} from "./local-agent-daemon-protocol.js";
import type { RunOverrides, StartLocalAgentInput } from "./local-agent-manager.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { WorkflowCall, WorkflowEvent, WorkflowRun, WorkflowRunInput } from "./workflow-types.js";

const CONFIG_REVISION = "test-provider-config";
// Only a scope value for the fake managers; the directory is never created.
const PROJECT_ROOT = join(tmpdir(), "ds-ad-project");
const record: LocalAgentRecord = {
  id: "agt_test",
  workspaceId: "ws_test",
  workspaceRoot: PROJECT_ROOT,
  profileName: "reviewer",
  providerInstanceId: "codex",
  driver: "codex",
  writeMode: "read_only",
  status: "running",
  createdAt: "now",
  updatedAt: "now",
};
const workflowRun: WorkflowRun = {
  id: "wfl_test",
  workspaceId: "ws_test",
  workspaceRoot: PROJECT_ROOT,
  name: "review",
  status: "running",
  writeMode: "read_only",
  concurrency: 1,
  createdAt: "now",
  updatedAt: "now",
  callCount: 1,
};
const workflowCall: WorkflowCall = {
  runId: workflowRun.id,
  index: 0,
  agentId: record.id,
  status: "running",
  prompt: "Review this",
  options: { target: "reviewer" },
  fingerprint: "fingerprint",
  workspaceRoot: workflowRun.workspaceRoot,
  workspaceId: workflowRun.workspaceId,
  createdAt: "now",
  updatedAt: "now",
};
const workflowEvent: WorkflowEvent = {
  sequence: 1,
  runId: workflowRun.id,
  type: "phase_started",
  data: { phase: "review" },
  createdAt: "now",
};

class FakeManager implements LocalAgentDaemonManager {
  constructor(private readonly closeOrder: string[] = []) {}
  activeTurnCount = 1;
  runtimeCount = 0;
  closed = false;
  lastInput?: StartLocalAgentInput;
  blockWaitUntilAbort = false;
  blockStartUntilRelease = false;
  startStarted = false;
  waitStarted = false;
  waitAborted = false;
  private releaseStart?: () => void;

  async start(input: StartLocalAgentInput) {
    this.lastInput = input;
    this.startStarted = true;
    if (this.blockStartUntilRelease) {
      await new Promise<void>((resolveStart) => { this.releaseStart = resolveStart; });
      this.activeTurnCount = 1;
    }
    return Result.ok(record);
  }

  releaseBlockedStart(): void {
    this.releaseStart?.();
    this.releaseStart = undefined;
  }

  async continue(
    _agentId: string,
    _prompt: string,
    _overrides: RunOverrides | undefined,
    _scope: { workspaceId: string; workspaceRoot: string },
  ) {
    return Result.ok({ ...record, status: "running" } as LocalAgentRecord);
  }

  get(_id: string, _scope: { workspaceId: string; workspaceRoot: string }) {
    return Result.ok(record);
  }

  list(_scope: { workspaceId: string; workspaceRoot: string }) {
    return Result.ok([record]);
  }

  async wait(agentIds: readonly string[], _scope: unknown, _timeoutMs?: number, signal?: AbortSignal) {
    this.waitStarted = true;
    if (this.blockWaitUntilAbort) {
      await new Promise<void>((resolveAbort) => {
        const onAbort = () => {
          this.waitAborted = true;
          resolveAbort();
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return Result.ok(agentIds.map((id) => ({ id, status: "running" as const })));
  }

  async stop(_agentId: string, _scope: unknown) {
    this.activeTurnCount = 0;
    return Result.ok({ ...record, status: "stopped" } as LocalAgentRecord);
  }

  lastEventsQuery?: unknown;

  events(agentId: string, _scope: unknown, query?: { turnId?: string; afterSeq?: number }) {
    this.lastEventsQuery = query;
    return Result.ok({
      agentId,
      turnId: "trn_test",
      status: "running" as const,
      events: [
        { type: "turn_started" as const, turnId: "trn_test", seq: 1, at: "now" },
        { type: "tool_started" as const, tool: "bash", summary: "pnpm test", turnId: "trn_test", seq: 2, at: "now" },
      ],
    });
  }

  async evictIdle(): Promise<void> {}

  async close(): Promise<void> {
    this.closeOrder.push("agents");
    this.closed = true;
    this.activeTurnCount = 0;
  }
}

class FakeWorkflows implements LocalAgentDaemonWorkflowManager {
  constructor(private readonly closeOrder: string[] = []) {}
  activeRunCount = 0;
  closed = false;
  cancelled = false;
  hangClose = false;
  blockWaitUntilAbort = false;
  waitAborted = false;
  lastInput?: WorkflowRunInput;
  async run(input: WorkflowRunInput): Promise<WorkflowRun> {
    this.lastInput = input;
    return workflowRun;
  }
  get(): WorkflowRun { return workflowRun; }
  list(): WorkflowRun[] { return [workflowRun]; }
  async wait(_id: string, _scope: unknown, _timeoutMs?: number, signal?: AbortSignal): Promise<WorkflowRun> {
    if (this.blockWaitUntilAbort) {
      await new Promise<void>((resolveAbort) => {
        const onAbort = () => { this.waitAborted = true; resolveAbort(); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return workflowRun;
  }
  calls(): WorkflowCall[] { return [workflowCall]; }
  call(): WorkflowCall { return workflowCall; }
  events(): WorkflowEvent[] { return [workflowEvent]; }
  async cancel(): Promise<WorkflowRun> { this.cancelled = true; return { ...workflowRun, status: "cancelled" }; }
  async close(): Promise<void> {
    this.closeOrder.push("workflows");
    if (this.hangClose) await new Promise<void>(() => {});
    this.closed = true;
    this.activeRunCount = 0;
  }
}

test("daemon diagnostics do not start a missing daemon", async (t) => {
  const { root } = await fixture(t);
  const missingDaemonStateDir = join(root, "missing-daemon-state");
  let diagnosticSpawnCount = 0;
  const missingDaemonClient = new LocalAgentClient({
    stateDir: missingDaemonStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 50,
    requestTimeoutMs: 50,
    spawnDaemon: () => { diagnosticSpawnCount += 1; },
  });
  for (const diagnostic of [
    () => missingDaemonClient.status(),
    () => missingDaemonClient.stop(),
    () => missingDaemonClient.logs(),
  ]) {
    const result = await diagnostic();
    assert.equal(result.isErr(), true);
    if (result.isErr()) assert.equal(result.error.code, "DAEMON_UNAVAILABLE");
  }
  assert.equal(diagnosticSpawnCount, 0, "daemon diagnostics must not start a missing daemon");
});

test("detached daemon startup does not inherit inspector flags", () => {
  assert.deepEqual(
    daemonExecArgv([
      "--enable-source-maps",
      "--inspect=127.0.0.1:9229",
      "--inspect-brk",
      "--inspect-wait=127.0.0.1:9230",
      "--inspect-port", "9231",
      "--trace-warnings",
    ]),
    ["--enable-source-maps", "--trace-warnings"],
    "detached daemon startup must not inherit inspector flags",
  );
});

test("the daemon reloads the same persisted configuration as its client", () => {
  assert.deepEqual(
    localAgentDaemonEnvironment("/alternate/config", { PATH: "/bin" }),
    { PATH: "/bin", DEVSPACE_CONFIG_DIR: "/alternate/config" },
    "the daemon must reload the same persisted configuration as its client",
  );
});

test("the client proxies agent and workflow requests and stop closes workflows before agents", async (t) => {
  const { root } = await fixture(t);
  const closeOrder: string[] = [];
  const manager = new FakeManager(closeOrder);
  const workflows = new FakeWorkflows(closeOrder);
  const daemon = new LocalAgentDaemon({
    stateDir: join(root, "state"),
    configRevision: CONFIG_REVISION,
    manager,
    workflows,
    idleShutdownMs: 60_000,
  });
  const client = new LocalAgentClient({
    stateDir: join(root, "state"),
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    spawnDaemon: () => { void daemon.start(); },
  });

  try {
    const started = unwrap(await client.run({
      target: "reviewer",
      prompt: "Review this",
      workspaceId: record.workspaceId!,
      workspaceRoot: PROJECT_ROOT,
    }));
    assert.equal(started.id, record.id);
    assert.equal(manager.lastInput?.prompt, "Review this");
    const recordScope = { workspaceId: record.workspaceId!, workspaceRoot: record.workspaceRoot };
    assert.equal(unwrap(await client.get(record.id, recordScope)).id, record.id);
    assert.equal(unwrap(await client.list(recordScope))[0]?.id, record.id);
    assert.deepEqual(unwrap(await client.wait([record.id], recordScope, 0)), [
      { id: record.id, status: "running" },
    ]);
    assert.equal(unwrap(await client.stopAgent(record.id, recordScope)).status, "stopped");
    const events = unwrap(await client.events(record.id, recordScope, { afterSeq: 0 }));
    assert.deepEqual(manager.lastEventsQuery, { turnId: undefined, afterSeq: 0 });
    assert.equal(events.turnId, "trn_test");
    assert.deepEqual(events.events.map((event) => event.type), ["turn_started", "tool_started"]);
    assert.equal(unwrap(await client.runWorkflow({
      ...recordScope,
      name: "review",
    })).id, workflowRun.id);
    assert.equal(workflows.lastInput?.name, "review");
    assert.equal(workflows.lastInput?.workspaceId, recordScope.workspaceId);
    assert.equal(workflows.lastInput?.workspaceRoot, recordScope.workspaceRoot);
    assert.equal(unwrap(await client.getWorkflow(workflowRun.id, recordScope)).id, workflowRun.id);
    assert.equal(unwrap(await client.listWorkflows(recordScope))[0]?.id, workflowRun.id);
    assert.equal(unwrap(await client.waitWorkflow(workflowRun.id, recordScope, 0)).status, "running");
    assert.equal(unwrap(await client.workflowCalls(workflowRun.id, recordScope))[0]?.index, 0);
    assert.equal(unwrap(await client.workflowCall(workflowRun.id, 0, recordScope)).agentId, record.id);
    assert.equal(unwrap(await client.workflowEvents(workflowRun.id, recordScope))[0]?.type, "phase_started");
    assert.equal(unwrap(await client.cancelWorkflow(workflowRun.id, recordScope)).status, "cancelled");
    assert.equal(unwrap(await client.status()).state, "ready");

    closeOrder.length = 0;
    unwrap(await client.stop());
    await waitFor(() => manager.closed && !existsSync(daemon.paths.socketPath));
    assert.deepEqual(closeOrder, ["workflows", "agents"]);
  } finally {
    await daemon.close();
  }
});

test("disconnecting a workflow wait does not cancel the workflow", async (t) => {
  const { root } = await fixture(t);
  const workflowWaitStateDir = join(root, "ww");
  const workflowWaitManager = new FakeManager();
  workflowWaitManager.activeTurnCount = 0;
  const workflowWaits = new FakeWorkflows();
  workflowWaits.blockWaitUntilAbort = true;
  workflowWaits.activeRunCount = 1;
  const workflowWaitDaemon = new LocalAgentDaemon({
    stateDir: workflowWaitStateDir,
    configRevision: CONFIG_REVISION,
    manager: workflowWaitManager,
    workflows: workflowWaits,
    idleShutdownMs: 60_000,
  });
  const workflowWaitClient = new LocalAgentClient({
    stateDir: workflowWaitStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 20,
    spawnDaemon: () => { void workflowWaitDaemon.start(); },
  });
  try {
    const result = await workflowWaitClient.waitWorkflow(workflowRun.id, {
      workspaceId: workflowRun.workspaceId,
      workspaceRoot: workflowRun.workspaceRoot,
    }, 0);
    assert.equal(result.isErr(), true);
    await waitFor(() => workflowWaits.waitAborted);
    assert.equal(workflowWaits.cancelled, false, "disconnecting a wait must not cancel the workflow");
    assert.equal(workflowWaits.activeRunCount, 1);
  } finally {
    workflowWaits.activeRunCount = 0;
    await workflowWaitDaemon.close();
  }
});

// A stalled workflow shutdown must leave budget for the agent manager phase.
test("a stalled workflow shutdown leaves budget for the agent manager phase", async (t) => {
  const { root } = await fixture(t);
  const stalledManager = new FakeManager();
  stalledManager.activeTurnCount = 0;
  const stalledWorkflows = new FakeWorkflows();
  stalledWorkflows.hangClose = true;
  const stalledDaemon = new LocalAgentDaemon({
    stateDir: join(root, "stalled-workflows"),
    configRevision: CONFIG_REVISION,
    manager: stalledManager,
    workflows: stalledWorkflows,
    shutdownTimeoutMs: 400,
    idleShutdownMs: 60_000,
  });
  const keepAlive = setInterval(() => {}, 50); // withTimeout timers are unref'd; a never-settling close would otherwise end the process
  try {
    await stalledDaemon.start();
    const stalledStart = Date.now();
    await stalledDaemon.close();
    assert.equal(stalledManager.closed, true, "agent manager must close even when workflows stall");
    assert.ok(Date.now() - stalledStart < 350, "a stalled workflow phase is capped at half the shutdown budget");
  } finally {
    clearInterval(keepAlive);
    await stalledDaemon.close();
  }
});

test("active workflows keep the daemon alive", async (t) => {
  const { root } = await fixture(t);
  const activeWorkflowStateDir = join(root, "aw");
  const activeWorkflowManager = new FakeManager();
  activeWorkflowManager.activeTurnCount = 0;
  const activeWorkflows = new FakeWorkflows();
  activeWorkflows.activeRunCount = 1;
  const activeWorkflowDaemon = new LocalAgentDaemon({
    stateDir: activeWorkflowStateDir,
    configRevision: CONFIG_REVISION,
    manager: activeWorkflowManager,
    workflows: activeWorkflows,
    idleShutdownMs: 20,
    idleCheckIntervalMs: 5,
  });
  try {
    await activeWorkflowDaemon.start();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    assert.equal(activeWorkflowManager.closed, false, "active workflows must keep the daemon alive");
    activeWorkflows.activeRunCount = 0;
    await waitFor(() => activeWorkflowManager.closed);
  } finally {
    await activeWorkflowDaemon.close();
  }
});

// Hidden in v1.1: a daemon built without a workflow manager rejects workflow requests with guidance.
test("a daemon without a workflow manager rejects workflow requests with guidance", async (t) => {
  const { root } = await fixture(t);
  const hiddenStateDir = join(root, "hidden-workflows-state");
  const hiddenManager = new FakeManager();
  hiddenManager.activeTurnCount = 0;
  const hiddenDaemon = new LocalAgentDaemon({
    stateDir: hiddenStateDir,
    configRevision: CONFIG_REVISION,
    manager: hiddenManager,
    idleShutdownMs: 60_000,
  });
  const hiddenClient = new LocalAgentClient({
    stateDir: hiddenStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    spawnDaemon: () => { void hiddenDaemon.start(); },
  });
  try {
    const rejected = await hiddenClient.runWorkflow({ workspaceId: record.workspaceId, workspaceRoot: record.workspaceRoot, name: "review" });
    assert.equal(rejected.isErr(), true);
    if (rejected.isErr()) {
      assert.equal(rejected.error.code, "WORKFLOWS_UNAVAILABLE");
      assert.match(rejected.error.message, /DEVSPACE_EXPERIMENTAL_WORKFLOWS=1/);
    }
    assert.equal(unwrap(await hiddenClient.status()).activeWorkflows, 0);
  } finally {
    await hiddenDaemon.close();
  }
});

test("an idle daemon shuts itself down", async (t) => {
  const { root } = await fixture(t);
  const idleStateDir = join(root, "idle-state");
  const idleManager = new FakeManager();
  idleManager.activeTurnCount = 0;
  const idleDaemon = new LocalAgentDaemon({
    stateDir: idleStateDir,
    configRevision: CONFIG_REVISION,
    manager: idleManager,
    idleShutdownMs: 200,
    idleCheckIntervalMs: 10,
  });
  const idleClient = new LocalAgentClient({
    stateDir: idleStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    spawnDaemon: () => { void idleDaemon.start(); },
  });

  try {
    unwrap(await idleClient.ensureReady());
    await waitFor(() => idleManager.closed && !existsSync(idleDaemon.paths.socketPath));
  } finally {
    await idleDaemon.close();
  }
});

test("only one competing daemon acquires the state-directory lock", async (t) => {
  const { root } = await fixture(t);
  const ownershipStateDir = join(root, "ownership-state");
  const ownerManager = new FakeManager();
  const competingManager = new FakeManager();
  const ownerDaemon = new LocalAgentDaemon({
    stateDir: ownershipStateDir,
    configRevision: CONFIG_REVISION,
    manager: ownerManager,
    idleShutdownMs: 60_000,
  });
  const competingDaemon = new LocalAgentDaemon({
    stateDir: ownershipStateDir,
    configRevision: CONFIG_REVISION,
    manager: competingManager,
    idleShutdownMs: 60_000,
  });

  try {
    const startupResults = await Promise.allSettled([
      ownerDaemon.start(),
      competingDaemon.start(),
    ]);
    assert.equal(
      startupResults.filter((result) => result.status === "fulfilled").length,
      1,
      "only one competing daemon may acquire the state-directory lock",
    );
    assert.equal(
      startupResults.filter((result) => result.status === "rejected").length,
      1,
    );
    const lockBefore = readFileSync(ownerDaemon.paths.lockPath, "utf8");
    const pidBefore = readFileSync(ownerDaemon.paths.pidPath, "utf8");
    // Closing the losing daemon must not release or rewrite the winner's lock.
    await competingDaemon.close();
    assert.equal(readFileSync(ownerDaemon.paths.lockPath, "utf8"), lockBefore);
    assert.equal(readFileSync(ownerDaemon.paths.pidPath, "utf8"), pidBefore);
    const ownerClient = new LocalAgentClient({
      stateDir: ownershipStateDir,
      configRevision: CONFIG_REVISION,
      spawnDaemon: () => { throw new Error("the winning daemon should already be reachable"); },
    });
    assert.equal(unwrap(await ownerClient.status()).pid, process.pid);
  } finally {
    await competingDaemon.close();
    await ownerDaemon.close();
  }
});

test("a failed daemon spawn reports a startup failure", async (t) => {
  const { root } = await fixture(t);
  const startupFailureClient = new LocalAgentClient({
    stateDir: join(root, "startup-failure-state"),
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 20,
    requestTimeoutMs: 10,
    spawnDaemon: () => { throw new Error("spawn failed"); },
  });
  const startupFailure = await startupFailureClient.ensureReady();
  assert.equal(startupFailure.isErr(), true);
  if (startupFailure.isErr()) assert.equal(startupFailure.error.code, "DAEMON_STARTUP_FAILURE");
});

// Keep Unix socket paths below macOS's short sockaddr_un path limit.
test("an idle daemon with a stale provider config is replaced", async (t) => {
  const { root } = await fixture(t);
  const staleIdleStateDir = join(root, "si");
  const staleIdleManager = new FakeManager();
  staleIdleManager.activeTurnCount = 0;
  const staleIdleDaemon = new LocalAgentDaemon({
    stateDir: staleIdleStateDir,
    configRevision: "old-provider-config",
    manager: staleIdleManager,
    idleShutdownMs: 60_000,
  });
  const currentManager = new FakeManager();
  currentManager.activeTurnCount = 0;
  const currentDaemon = new LocalAgentDaemon({
    stateDir: staleIdleStateDir,
    configRevision: CONFIG_REVISION,
    manager: currentManager,
    idleShutdownMs: 60_000,
  });
  let currentDaemonSpawns = 0;
  const staleIdleClient = new LocalAgentClient({
    stateDir: staleIdleStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 500,
    spawnDaemon: () => {
      currentDaemonSpawns += 1;
      void currentDaemon.start();
    },
  });
  try {
    await staleIdleDaemon.start();
    assert.equal(unwrap(await staleIdleClient.ensureReady()).state, "ready");
    assert.equal(staleIdleManager.closed, true);
    assert.equal(currentDaemonSpawns, 1);
  } finally {
    await staleIdleDaemon.close();
    await currentDaemon.close();
  }
});

test("a busy daemon with a stale provider config keeps serving but rejects new starts", async (t) => {
  const { root } = await fixture(t);
  const staleActiveStateDir = join(root, "sa");
  const staleActiveManager = new FakeManager();
  const staleActiveWorkflows = new FakeWorkflows();
  const staleActiveDaemon = new LocalAgentDaemon({
    stateDir: staleActiveStateDir,
    configRevision: "old-provider-config",
    manager: staleActiveManager,
    workflows: staleActiveWorkflows,
    idleShutdownMs: 60_000,
  });
  let staleActiveSpawns = 0;
  const staleActiveClient = new LocalAgentClient({
    stateDir: staleActiveStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 500,
    requestTimeoutMs: 500,
    spawnDaemon: () => { staleActiveSpawns += 1; },
  });
  try {
    await staleActiveDaemon.start();
    const changed = await staleActiveClient.ensureReady();
    assert.equal(changed.isErr(), true);
    if (changed.isErr()) {
      assert.equal(changed.error.code, "DAEMON_CONFIG_CHANGED");
      assert.equal(changed.error.retryable, true);
    }
    assert.equal(staleActiveSpawns, 0);
    assert.equal(staleActiveManager.closed, false);
    const staleScope = { workspaceId: record.workspaceId!, workspaceRoot: record.workspaceRoot };
    assert.equal(unwrap(await staleActiveClient.get(record.id, staleScope)).id, record.id);
    assert.equal(unwrap(await staleActiveClient.list(staleScope))[0]?.id, record.id);
    assert.deepEqual(unwrap(await staleActiveClient.wait([record.id], staleScope, 0)), [
      { id: record.id, status: "running" },
    ]);
    assert.equal(unwrap(await staleActiveClient.cancelWorkflow(workflowRun.id, staleScope)).status, "cancelled");
    const blockedStart = await staleActiveClient.run({
      target: "reviewer",
      prompt: "must use current provider config",
      workspaceId: record.workspaceId!,
      workspaceRoot: record.workspaceRoot,
    });
    assert.equal(blockedStart.isErr(), true);
    if (blockedStart.isErr()) assert.equal(blockedStart.error.code, "DAEMON_CONFIG_CHANGED");
    assert.equal("configRevision" in unwrap(await staleActiveClient.status()), false);
  } finally {
    await staleActiveDaemon.close();
  }
});

test("a daemon with an agent start in flight is not replaced for a config change", async (t) => {
  const { root } = await fixture(t);
  const configRaceStateDir = join(root, "sr");
  const configRaceManager = new FakeManager();
  configRaceManager.activeTurnCount = 0;
  configRaceManager.blockStartUntilRelease = true;
  const configRaceDaemon = new LocalAgentDaemon({
    stateDir: configRaceStateDir,
    configRevision: "old-provider-config",
    manager: configRaceManager,
    idleShutdownMs: 60_000,
  });
  const matchingRaceClient = new LocalAgentClient({
    stateDir: configRaceStateDir,
    configRevision: "old-provider-config",
    spawnDaemon: () => { throw new Error("the existing daemon should be used"); },
  });
  const changedRaceClient = new LocalAgentClient({
    stateDir: configRaceStateDir,
    configRevision: CONFIG_REVISION,
    spawnDaemon: () => { throw new Error("a busy daemon must not be replaced"); },
  });
  try {
    await configRaceDaemon.start();
    const starting = matchingRaceClient.run({
      target: "reviewer",
      prompt: "race with replacement",
      workspaceId: record.workspaceId,
      workspaceRoot: record.workspaceRoot,
    });
    await waitFor(() => configRaceManager.startStarted);
    const changed = await changedRaceClient.ensureReady();
    assert.equal(changed.isErr(), true);
    if (changed.isErr()) assert.equal(changed.error.code, "DAEMON_CONFIG_CHANGED");
    assert.equal(configRaceManager.closed, false);
    configRaceManager.releaseBlockedStart();
    unwrap(await starting);
  } finally {
    configRaceManager.releaseBlockedStart();
    await configRaceDaemon.close();
  }
});

test("a legacy-protocol daemon is stopped and replaced only after it releases its lock", async (t) => {
  const { root } = await fixture(t);
  const upgradeStateDir = join(root, "upgrade-state");
  await mkdir(upgradeStateDir, { recursive: true });
  const upgradePaths = localAgentDaemonPaths(upgradeStateDir);
  ensureLocalAgentDaemonSecret(upgradePaths);
  const legacyLock = new LocalAgentDaemonLock(upgradePaths);
  legacyLock.acquire();
  const legacyMethods: string[] = [];
  const legacyServer = await listenFakeDaemon(upgradePaths.endpoint, (request, socket) => {
    legacyMethods.push(`${request.method}:${request.protocolVersion}`);
    if (request.protocolVersion !== 1) {
      socket.end(protocolMismatch(request, 1));
      return;
    }
    const stopping = request.method === "daemon.stop";
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: 1,
      ok: true,
      result: fakeDaemonStatus(upgradePaths.endpoint, 1, stopping ? "stopping" : "ready"),
    }), () => {
      if (stopping) {
        legacyServer.close(() => {
          setTimeout(() => legacyLock.release(), 50);
        });
      }
    });
  });
  const replacementManager = new FakeManager();
  replacementManager.activeTurnCount = 0;
  const replacementDaemon = new LocalAgentDaemon({
    stateDir: upgradeStateDir,
    configRevision: CONFIG_REVISION,
    manager: replacementManager,
    idleShutdownMs: 60_000,
  });
  let replacementSpawns = 0;
  let spawnedBeforeLegacyLockReleased = false;
  const upgradeClient = new LocalAgentClient({
    stateDir: upgradeStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 500,
    spawnDaemon: () => {
      replacementSpawns += 1;
      spawnedBeforeLegacyLockReleased = existsSync(upgradePaths.lockPath);
      void replacementDaemon.start();
    },
  });
  try {
    assert.equal(
      unwrap(await upgradeClient.ensureReady()).protocolVersion,
      LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    );
    assert.equal(replacementSpawns, 1);
    assert.equal(spawnedBeforeLegacyLockReleased, false);
    assert.deepEqual(legacyMethods.slice(0, 3), [
      `hello:${LOCAL_AGENT_DAEMON_PROTOCOL_VERSION}`,
      "hello:1",
      "daemon.stop:1",
    ]);
  } finally {
    legacyLock.release();
    await replacementDaemon.close();
  }
});

test("a daemon that is replaced concurrently is accepted once it speaks the current protocol", async (t) => {
  const { root } = await fixture(t);
  const replacementRaceStateDir = join(root, "upgrade-race-state");
  await mkdir(replacementRaceStateDir, { recursive: true });
  const replacementRacePaths = localAgentDaemonPaths(replacementRaceStateDir);
  ensureLocalAgentDaemonSecret(replacementRacePaths);
  let replacementRaceProtocol = 1;
  const replacementRaceServer = await listenFakeDaemon(replacementRacePaths.endpoint, (request, socket) => {
    if (request.protocolVersion !== replacementRaceProtocol) {
      socket.end(protocolMismatch(request, replacementRaceProtocol));
      return;
    }
    const status = fakeDaemonStatus(
      replacementRacePaths.endpoint,
      replacementRaceProtocol,
      request.method === "daemon.stop" ? "stopping" : "ready",
    );
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: replacementRaceProtocol,
      ok: true,
      result: request.method === "hello"
        && replacementRaceProtocol === LOCAL_AGENT_DAEMON_PROTOCOL_VERSION
        ? { status, configMatches: true }
        : status,
    }), () => {
      if (request.method === "daemon.stop") {
        replacementRaceProtocol = LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
      }
    });
  });
  const replacementRaceClient = new LocalAgentClient({
    stateDir: replacementRaceStateDir,
    configRevision: CONFIG_REVISION,
    startupTimeoutMs: 500,
    requestTimeoutMs: 100,
    spawnDaemon: () => {
      throw new Error("the replacement daemon is already running");
    },
  });
  try {
    assert.equal(
      unwrap(await replacementRaceClient.ensureReady()).protocolVersion,
      LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    );
  } finally {
    await new Promise<void>((resolveClose) => replacementRaceServer.close(() => resolveClose()));
  }
});

test("a daemon that never answers a request times out", async (t) => {
  const { root } = await fixture(t);
  const timeoutStateDir = join(root, "request-timeout-state");
  await mkdir(timeoutStateDir, { recursive: true });
  const timeoutPaths = localAgentDaemonPaths(timeoutStateDir);
  ensureLocalAgentDaemonSecret(timeoutPaths);
  const timeoutServer = await listenFakeDaemon(timeoutPaths.endpoint, (request, socket) => {
    if (request.method !== "hello") return;
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: true,
      result: fakeDaemonStatus(timeoutPaths.endpoint, LOCAL_AGENT_DAEMON_PROTOCOL_VERSION),
    }));
  });
  try {
    const timeoutClient = new LocalAgentClient({
      stateDir: timeoutStateDir,
      configRevision: CONFIG_REVISION,
      endpoint: timeoutPaths.endpoint,
      requestTimeoutMs: 20,
      spawnDaemon: () => { throw new Error("existing daemon should be used"); },
    });
    const timedOut = await timeoutClient.status();
    assert.equal(timedOut.isErr(), true);
    if (timedOut.isErr()) assert.equal(timedOut.error.code, "DAEMON_TIMEOUT");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      timeoutServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("a response for another request is invalid", async (t) => {
  const { root } = await fixture(t);
  const invalidStateDir = join(root, "invalid-response-state");
  await mkdir(invalidStateDir, { recursive: true });
  const invalidPaths = localAgentDaemonPaths(invalidStateDir);
  const invalidServer = await listenFakeDaemon(invalidPaths.endpoint, (_request, socket) => {
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: "wrong_request_id",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: true,
      result: {},
    }));
  });
  try {
    const invalidClient = new LocalAgentClient({
      stateDir: invalidStateDir,
      configRevision: CONFIG_REVISION,
      endpoint: invalidPaths.endpoint,
      requestTimeoutMs: 50,
      spawnDaemon: () => { throw new Error("existing daemon should be used"); },
    });
    const invalid = await invalidClient.ensureReady();
    assert.equal(invalid.isErr(), true);
    if (invalid.isErr()) assert.equal(invalid.error.code, "DAEMON_INVALID_RESPONSE");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      invalidServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

type RawDaemonRequest = { requestId: string; protocolVersion: number; method: string };

// A hand-rolled daemon endpoint for protocol edge cases the real daemon never produces.
async function listenFakeDaemon(
  endpoint: string,
  respond: (request: RawDaemonRequest, socket: Socket) => void,
): Promise<NetServer> {
  const server = createNetServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      respond(JSON.parse(buffer.slice(0, newline)) as RawDaemonRequest, socket);
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(endpoint, resolveListen);
  });
  return server;
}

function fakeDaemonStatus(endpoint: string, protocolVersion: number, state: "ready" | "stopping" = "ready") {
  return {
    state,
    protocolVersion,
    pid: process.pid,
    endpoint,
    startedAt: "now",
    activeTurns: 0,
    runtimeCount: 0,
    clientConnections: 1,
  };
}

function protocolMismatch(request: RawDaemonRequest, protocolVersion: number): string {
  return encodeLocalAgentDaemonResponse({
    requestId: request.requestId,
    protocolVersion,
    ok: false,
    error: {
      code: "DAEMON_PROTOCOL_MISMATCH",
      message: `Unsupported daemon protocol version ${request.protocolVersion}.`,
      retryable: false,
    },
  });
}

function unwrap<T, E>(result: import("better-result").Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

test("disconnecting a socket aborts its pending agent wait", async (t) => {
  const { socketManager, socketDaemon } = await startSocketDaemon(t);
  socketManager.blockWaitUntilAbort = true;
  const waitSocket = createConnection(socketDaemon.paths.endpoint);
  await new Promise<void>((resolveConnect, rejectConnect) => {
    waitSocket.once("error", rejectConnect);
    waitSocket.once("connect", resolveConnect);
  });
  waitSocket.write(JSON.stringify({
    requestId: "disconnect-wait",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: ensureLocalAgentDaemonSecret(socketDaemon.paths),
    method: "agent.wait",
    params: {
      ids: [record.id],
      scope: { workspaceId: record.workspaceId, workspaceRoot: record.workspaceRoot },
    },
  }) + "\n");
  await waitFor(() => socketManager.waitStarted);
  waitSocket.destroy();
  await waitFor(() => socketManager.waitAborted);
  socketManager.blockWaitUntilAbort = false;
});

test("a request that is never sent times out and releases its connection", async (t) => {
  const { socketDaemon } = await startSocketDaemon(t);
  const timedOutRequest = await sendRawRequest(socketDaemon.paths.endpoint);
  assert.equal(timedOutRequest.ok, false);
  if (!timedOutRequest.ok) {
    assert.equal(timedOutRequest.error.code, "DAEMON_TIMEOUT");
    assert.equal(timedOutRequest.error.retryable, true);
  }
  await waitFor(() => socketDaemon.status().clientConnections === 0);
});

test("a request with the wrong secret is unauthorized", async (t) => {
  const { socketDaemon } = await startSocketDaemon(t);
  const unauthorized = await sendRawRequest(socketDaemon.paths.endpoint, JSON.stringify({
    requestId: "unauthorized",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "wrong-secret",
    method: "hello",
    params: {},
    configRevision: CONFIG_REVISION,
  }) + "\n");
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.error.code, "DAEMON_UNAUTHORIZED");
});

test("malformed and oversized requests are invalid", async (t) => {
  const { socketDaemon } = await startSocketDaemon(t);
  const malformed = await sendRawRequest(socketDaemon.paths.endpoint, "{not-json}\n");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "DAEMON_INVALID_REQUEST");

  const oversized = await sendRawRequest(socketDaemon.paths.endpoint, "x".repeat(512 * 1024 + 1));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "DAEMON_INVALID_REQUEST");
});

test("shutdown destroys idle client sockets before closing the server", async (t) => {
  const { socketDaemon } = await startSocketDaemon(t);
  const shutdownSocket = createConnection(socketDaemon.paths.endpoint);
  try {
    await onceSocket(shutdownSocket, "connect");
    const shutdownSocketClosed = onceSocket(shutdownSocket, "close");
    const startedAt = Date.now();
    await socketDaemon.close();
    await shutdownSocketClosed;
    assert.ok(Date.now() - startedAt < 500, "shutdown should destroy idle client sockets before closing the server");
  } finally {
    shutdownSocket.destroy();
  }
});

async function startSocketDaemon(t: TestContext) {
  const { root, onCleanup } = await fixture(t);
  const socketStateDir = join(root, "socket-state");
  const socketManager = new FakeManager();
  socketManager.activeTurnCount = 0;
  const socketDaemon = new LocalAgentDaemon({
    stateDir: socketStateDir,
    configRevision: CONFIG_REVISION,
    manager: socketManager,
    requestReadTimeoutMs: 30,
    shutdownTimeoutMs: 100,
    idleShutdownMs: 60_000,
  });
  onCleanup(() => socketDaemon.close());
  await socketDaemon.start();
  return { socketManager, socketDaemon };
}

async function fixture(t: TestContext) {
  // macOS limits the complete Unix socket path to 104 bytes.
  const root = await mkdtemp(join(tmpdir(), "ds-ad-"));
  // Daemons and servers must close before their state directory is removed.
  const cleanups: Array<() => unknown> = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { root, onCleanup: (cleanup: () => unknown) => { cleanups.push(cleanup); } };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}

async function sendRawRequest(
  endpoint: string,
  payload?: string,
): Promise<RawDaemonResponse> {
  const socket = createConnection(endpoint);
  socket.setEncoding("utf8");
  const connected = onceSocket(socket, "connect");
  let buffer = "";
  const response = new Promise<RawDaemonResponse>((resolveResponse, rejectResponse) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onEnd);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as RawDaemonResponse;
        settle(() => resolveResponse(parsed));
      } catch (error) {
        settle(() => rejectResponse(error));
      }
    };
    const onError = (error: Error) => settle(() => rejectResponse(error));
    const onClose = () => settle(() => rejectResponse(
      new Error("Daemon closed the connection before returning a response."),
    ));
    const onEnd = () => settle(() => rejectResponse(
      new Error("Daemon ended the connection before returning a response."),
    ));
    const timeout = setTimeout(() => settle(() => rejectResponse(
      new Error("Daemon did not return a response within 2000ms."),
    )), 2_000);
    timeout.unref();

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onEnd);
  });
  await connected;
  if (payload !== undefined) socket.write(payload);
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

type RawDaemonResponse =
  | { ok: true }
  | { ok: false; error: { code?: string; retryable?: boolean } };

function onceSocket(
  socket: ReturnType<typeof createConnection>,
  event: "connect" | "close",
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket did not emit ${event} within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off("error", onError);
    };

    socket.once(event, onEvent);
    socket.once("error", onError);
  });
}
