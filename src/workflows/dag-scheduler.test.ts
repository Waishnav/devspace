import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { LocalAgentRunController, type LocalAgentRunHandle } from "../local-agent-runtime.js";
import { runWorkflowSupervisor } from "./supervisor.js";
import { WorkflowStore } from "./store.js";
import {
  allocateWorkflowWorktree,
  cleanupExpiredWorkflowWorktrees,
  cleanupWorkflowWorktree,
  preserveWorkflowWorktree,
} from "./worktrees.js";
import type { JsonObject, WorkflowDefinitionV1 } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-dag-test-"));
try {
  await testParallelBoundedScheduling(join(root, "parallel"));
  await testFairSchedulingAcrossRuns(join(root, "fairness"));
  testFairSchedulingWithTiedTimestamps(join(root, "fairness-tied"));
  await testExplicitReadOnlyRetry(join(root, "retry"));
  await testRetryFailureClasses(join(root, "retry-classes"));
  await testManagedWriteWorktree(join(root, "worktree"));
  await testExpiredWorktreeCleanup(join(root, "worktree-retention"));
  await testWorktreeCleanupRejectsRootSubstitution(join(root, "cleanup-guard"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function testParallelBoundedScheduling(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({
    definition: definition(["a", "b", "c"], { access: "read_only" }),
    policy: { version: 1, maxConcurrency: 2 },
  }).workflow;
  store.close();

  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const handleFactory = async (_provider: string, input: { prompt: string }): Promise<LocalAgentRunHandle> => {
    active += 1;
    maximum = Math.max(maximum, active);
    started.push(input.prompt);
    const controller = new LocalAgentRunController("fake");
    const timer = setTimeout(() => {
      active -= 1;
      controller.succeed({ provider: "fake", providerSessionId: `session-${input.prompt}`, finalResponse: input.prompt, items: [] });
    }, 40);
    controller.setLifecycle({
      cancel: () => {
        clearTimeout(timer);
        active = Math.max(0, active - 1);
      },
      dispose: () => clearTimeout(timer),
    });
    return controller;
  };

  assert.equal(await runWorkflowSupervisor(stateDir, {
    handleFactory,
    globalConcurrency: 2,
    heartbeatMs: 10,
    nodeLeaseMs: 500,
    supervisorLeaseMs: 500,
    idleMs: 0,
  }), true);
  assert.equal(maximum, 2);
  assert.deepEqual(started.sort(), ["a", "b", "c"]);
  const reader = new WorkflowStore(stateDir);
  try {
    assert.equal(reader.require(workflow.id).status, "succeeded");
  } finally {
    reader.close();
  }
}

async function testFairSchedulingAcrossRuns(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const first = store.submit({
    definition: definition(["first-a", "first-b"], { access: "read_only" }),
    policy: { version: 1, maxConcurrency: 2 },
  }).workflow;
  const second = store.submit({
    definition: definition(["second-a", "second-b"], { access: "read_only" }),
    policy: { version: 1, maxConcurrency: 2 },
  }).workflow;
  store.close();

  const started: string[] = [];
  const handleFactory = async (_provider: string, input: { prompt: string }): Promise<LocalAgentRunHandle> => {
    started.push(input.prompt);
    const controller = new LocalAgentRunController("fake");
    const timer = setTimeout(() => {
      controller.succeed({
        provider: "fake",
        providerSessionId: `fair-${input.prompt}`,
        finalResponse: input.prompt,
        items: [],
      });
    }, 40);
    controller.setLifecycle({
      cancel: () => clearTimeout(timer),
      dispose: () => clearTimeout(timer),
    });
    return controller;
  };

  await runWorkflowSupervisor(stateDir, {
    handleFactory,
    globalConcurrency: 2,
    heartbeatMs: 10,
    nodeLeaseMs: 500,
    supervisorLeaseMs: 500,
    idleMs: 0,
  });
  assert.equal(started.length, 4);
  assert.equal(started.slice(0, 2).filter((prompt) => prompt.startsWith("first-")).length, 1);
  assert.equal(started.slice(0, 2).filter((prompt) => prompt.startsWith("second-")).length, 1);
  const reader = new WorkflowStore(stateDir);
  try {
    assert.equal(reader.require(first.id).status, "succeeded");
    assert.equal(reader.require(second.id).status, "succeeded");
  } finally {
    reader.close();
  }
}

function testFairSchedulingWithTiedTimestamps(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  const first = store.submit({
    definition: definition(["first-a", "first-b"], { access: "read_only" }),
    policy: { version: 1, maxConcurrency: 2 },
  }).workflow;
  const second = store.submit({
    definition: definition(["second-a", "second-b"], { access: "read_only" }),
    policy: { version: 1, maxConcurrency: 2 },
  }).workflow;
  const supervisor = store.acquireSupervisor({ ownerToken: "fair-tie", ownerPid: 1, leaseMs: 1_000 })!;
  const firstClaim = store.claimNextAgentNode({ supervisor, claimToken: "first", leaseMs: 1_000 })!;
  assert.equal(firstClaim.workflow.id, first.id);

  const database = openDatabase(stateDir);
  database.sqlite.prepare("update workflow_runs set last_dispatched_at = ? where id in (?, ?)")
    .run("2026-01-01T00:00:00.000Z", first.id, second.id);
  database.close();

  const secondClaim = store.claimNextAgentNode({ supervisor, claimToken: "second", leaseMs: 1_000 })!;
  assert.equal(secondClaim.workflow.id, second.id);
  store.releaseSupervisor(supervisor);
  store.close();
}

async function testExplicitReadOnlyRetry(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({
    definition: definition(["retry"], {
      access: "read_only",
      retry: { maxAttempts: 2, retryOn: ["provider_failed"], backoffMs: 0 },
    }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  store.close();
  let starts = 0;
  const handleFactory = async (): Promise<LocalAgentRunHandle> => {
    starts += 1;
    if (starts === 1) throw new Error("first attempt fails");
    const controller = new LocalAgentRunController("fake");
    queueMicrotask(() => controller.succeed({ provider: "fake", providerSessionId: "retry-session", finalResponse: "ok", items: [] }));
    return controller;
  };

  await runWorkflowSupervisor(stateDir, {
    handleFactory,
    globalConcurrency: 1,
    heartbeatMs: 10,
    nodeLeaseMs: 500,
    supervisorLeaseMs: 500,
    idleMs: 0,
  });
  const reader = new WorkflowStore(stateDir);
  try {
    const completed = reader.require(workflow.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.nodes[0]!.attempt, 2);
    assert.ok(reader.readEvents(workflow.id, { limit: 100 }).events.some((event) => event.type === "node.retry_scheduled"));
  } finally {
    reader.close();
  }
}

async function testRetryFailureClasses(stateDir: string): Promise<void> {
  const resultStore = new WorkflowStore(stateDir);
  const resultRetry = resultStore.submit({
    definition: definition(["result-retry"], {
      access: "read_only",
      retry: { maxAttempts: 2, retryOn: ["provider_failed"], backoffMs: 0 },
    }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  resultStore.close();
  let resultStarts = 0;
  await runWorkflowSupervisor(stateDir, {
    globalConcurrency: 1,
    heartbeatMs: 5,
    nodeLeaseMs: 200,
    supervisorLeaseMs: 200,
    idleMs: 0,
    handleFactory: async () => {
      resultStarts += 1;
      const controller = new LocalAgentRunController("fake");
      queueMicrotask(() => {
        if (resultStarts === 1) controller.fail(new Error("result rejected"));
        else controller.succeed({ provider: "fake", providerSessionId: "result-retry", finalResponse: "ok", items: [] });
      });
      return controller;
    },
  });
  const resultReader = new WorkflowStore(stateDir);
  assert.equal(resultReader.require(resultRetry.id).status, "succeeded");
  assert.equal(resultReader.require(resultRetry.id).nodes[0]!.attempt, 2);
  resultReader.close();

  const timeoutStore = new WorkflowStore(stateDir);
  const timeoutRetry = timeoutStore.submit({
    definition: definition(["timeout-retry"], {
      access: "read_only",
      timeoutMs: 10,
      retry: { maxAttempts: 2, retryOn: ["timed_out"], backoffMs: 20 },
    }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  timeoutStore.close();
  const timeoutStarts: number[] = [];
  await runWorkflowSupervisor(stateDir, {
    globalConcurrency: 1,
    heartbeatMs: 5,
    nodeLeaseMs: 200,
    supervisorLeaseMs: 200,
    idleMs: 0,
    handleFactory: async () => {
      timeoutStarts.push(Date.now());
      const controller = new LocalAgentRunController("fake");
      const timer = setTimeout(() => controller.succeed({
        provider: "fake",
        providerSessionId: "late-timeout",
        finalResponse: "late",
        items: [],
      }), 30);
      controller.setLifecycle({ cancel: () => undefined, dispose: () => clearTimeout(timer) });
      return controller;
    },
  });
  const timeoutReader = new WorkflowStore(stateDir);
  const timedOut = timeoutReader.require(timeoutRetry.id);
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.nodes[0]!.attempt, 2);
  assert.equal((timedOut.error as JsonObject).code, "timed_out");
  assert.ok(timeoutStarts[1]! - timeoutStarts[0]! >= 15, "retry backoff must delay the second attempt");
  timeoutReader.close();

  const nonRetryStore = new WorkflowStore(stateDir);
  const nonRetry = nonRetryStore.submit({
    definition: definition(["non-retryable"], {
      access: "read_only",
      retry: { maxAttempts: 3, retryOn: ["timed_out"], backoffMs: 0 },
    }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  nonRetryStore.close();
  let nonRetryStarts = 0;
  await runWorkflowSupervisor(stateDir, {
    globalConcurrency: 1,
    heartbeatMs: 5,
    nodeLeaseMs: 200,
    supervisorLeaseMs: 200,
    idleMs: 0,
    handleFactory: async () => {
      nonRetryStarts += 1;
      throw new Error("not retryable by policy");
    },
  });
  const nonRetryReader = new WorkflowStore(stateDir);
  assert.equal(nonRetryReader.require(nonRetry.id).status, "failed");
  assert.equal(nonRetryReader.require(nonRetry.id).nodes[0]!.attempt, 1);
  assert.equal(nonRetryStarts, 1);
  nonRetryReader.close();
}

async function testManagedWriteWorktree(stateDir: string): Promise<void> {
  const repo = join(stateDir, "repo");
  const worktreeRoot = join(stateDir, "managed");
  execFileSync("mkdir", ["-p", repo]);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "source.txt"), "source\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({
    definition: definition(["writer"], {
      access: "workspace_write",
      workspaceRoot: repo,
      worktreeRoot,
      baseSha,
    }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  store.close();
  let executionRoot = "";
  const handleFactory = async (_provider: string, input: { workspace: string }): Promise<LocalAgentRunHandle> => {
    executionRoot = input.workspace;
    writeFileSync(join(input.workspace, "source.txt"), "isolated\n");
    execFileSync("git", ["add", "source.txt"], { cwd: input.workspace });
    execFileSync("git", ["commit", "-qm", "agent change"], { cwd: input.workspace });
    const controller = new LocalAgentRunController("fake");
    queueMicrotask(() => controller.succeed({ provider: "fake", providerSessionId: "writer-session", finalResponse: "changed", items: [] }));
    return controller;
  };

  await runWorkflowSupervisor(stateDir, {
    handleFactory,
    globalConcurrency: 1,
    heartbeatMs: 10,
    nodeLeaseMs: 1_000,
    supervisorLeaseMs: 1_000,
    idleMs: 0,
  });
  assert.notEqual(executionRoot, repo);
  assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "source\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
  const reader = new WorkflowStore(stateDir);
  try {
    assert.equal(reader.require(workflow.id).status, "succeeded");
    assert.equal(reader.getWorktree(workflow.id, "writer", 1)?.state, "removed");
  } finally {
    reader.close();
  }
}

async function testExpiredWorktreeCleanup(stateDir: string): Promise<void> {
  const repo = join(stateDir, "repo");
  const worktreeRoot = join(stateDir, "managed");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "source.txt"), "source\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({
    definition: definition(["writer"], { access: "workspace_write", workspaceRoot: repo, worktreeRoot, baseSha }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  const identity = {
    workflowId: workflow.id,
    nodeKey: "writer",
    attempt: 1,
    claimToken: "retention-claim",
  };
  const allocation = await allocateWorkflowWorktree({ store, identity, sourceRoot: repo, worktreeRoot, baseSha });
  preserveWorkflowWorktree(store, identity);
  const database = openDatabase(stateDir);
  database.sqlite.prepare(
    "update workflow_worktrees set retain_until = ? where workflow_run_id = ? and node_key = ? and attempt = ?",
  ).run("2020-01-01T00:00:00.000Z", workflow.id, "writer", 1);
  database.close();

  assert.equal(await cleanupExpiredWorkflowWorktrees({ store }), 1);
  assert.equal(store.getWorktree(workflow.id, "writer", 1)?.state, "removed");
  assert.equal(existsSync(allocation.path), false);
  store.close();
}

async function testWorktreeCleanupRejectsRootSubstitution(stateDir: string): Promise<void> {
  const repo = join(stateDir, "repo");
  const worktreeRoot = join(stateDir, "managed");
  const outside = join(stateDir, "outside");
  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "source.txt"), "source\n");
  writeFileSync(join(outside, "marker.txt"), "keep\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({
    definition: definition(["writer"], { access: "workspace_write", workspaceRoot: repo, worktreeRoot, baseSha }),
    policy: { version: 1, maxConcurrency: 1 },
  }).workflow;
  const identity = {
    workflowId: workflow.id,
    nodeKey: "writer",
    attempt: 1,
    claimToken: "cleanup-claim",
    supervisorOwnerToken: "cleanup-owner",
    supervisorOwnerEpoch: 1,
  };
  const allocation = await allocateWorkflowWorktree({
    store,
    identity,
    sourceRoot: repo,
    worktreeRoot,
    baseSha,
  });
  execFileSync("git", ["worktree", "remove", "--force", allocation.path], { cwd: repo });
  symlinkSync(outside, allocation.path, "dir");

  await assert.rejects(
    cleanupWorkflowWorktree({ store, identity, worktreeRoot }),
    /escapes the managed root/,
  );
  assert.equal(readFileSync(join(outside, "marker.txt"), "utf8"), "keep\n");
  assert.equal(store.getWorktree(workflow.id, "writer", 1)?.state, "cleanup_failed");
  store.close();
}

function definition(keys: string[], overrides: JsonObject): WorkflowDefinitionV1 {
  return {
    version: 1,
    nodes: keys.map((key) => ({
      key,
      type: "agent" as const,
      config: {
        provider: "fake",
        prompt: key,
        profileBody: "",
        workspaceRoot: String(overrides.workspaceRoot ?? process.cwd()),
        worktreeRoot: String(overrides.worktreeRoot ?? ""),
        baseSha: String(overrides.baseSha ?? ""),
        timeoutMs: overrides.timeoutMs ?? null,
        effectivePolicy: {
          version: 1,
          mode: "workflow",
          access: String(overrides.access ?? "read_only"),
          environment: {},
        },
        retry: (overrides.retry ?? { maxAttempts: 1, retryOn: [], backoffMs: 0 }) as JsonObject,
      },
    })),
    edges: [],
  };
}
