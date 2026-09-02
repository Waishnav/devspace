import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, type ServerConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { releaseWorkspaceLease } from "./workspace-lifecycle.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

interface LifecycleFixture {
  root: string;
  sourceRoot: string;
  worktreeRoot: string;
  stateDir: string;
  config: ServerConfig;
}

async function lifecycleFixture(t: TestContext): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-lifecycle-test-"));
  const sourceRoot = join(root, "project");
  const worktreeRoot = join(root, ".devspace", "worktrees");
  const stateDir = join(root, ".state");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".devspace-home"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot,
    },
  }));

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return { root, sourceRoot, worktreeRoot, stateDir, config };
}

test("explicit release persists across restart and retains the managed worktree", async (t) => {
  const fixture = await lifecycleFixture(t);
  const managedRoot = join(fixture.worktreeRoot, "managed-retained");
  const retainedFile = join(managedRoot, "unique.txt");
  await mkdir(managedRoot);
  await writeFile(retainedFile, "unique source remains\n");

  const firstStore = new SqliteWorkspaceStore(fixture.stateDir);
  firstStore.createSession({
    id: "ws_released",
    root: managedRoot,
    mode: "worktree",
    sourceRoot: fixture.sourceRoot,
    baseRef: "origin/main",
    baseSha: "abc123",
    managed: true,
  });
  const firstRegistry = new WorkspaceRegistry(fixture.config, firstStore);

  const released = firstRegistry.releaseWorkspace("ws_released");
  assert.equal(released.status, "released");
  assert.equal(released.terminalReason, "explicit_release");
  assert.ok(released.terminalAt);
  assert.equal((await stat(managedRoot)).isDirectory(), true);
  assert.equal((await stat(retainedFile)).isFile(), true);

  const releasedAgain = firstRegistry.releaseWorkspace("ws_released");
  assert.equal(releasedAgain.status, "released");
  assert.equal(releasedAgain.terminalAt, released.terminalAt);
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(fixture.stateDir);
  try {
    const restored = secondStore.getSession("ws_released");
    assert.equal(restored?.status, "released");
    assert.equal(restored?.terminalAt, released.terminalAt);

    const secondRegistry = new WorkspaceRegistry(fixture.config, secondStore);
    assert.throws(
      () => secondRegistry.getWorkspace("ws_released"),
      /is released and cannot be reused/,
    );
    assert.equal((await stat(retainedFile)).isFile(), true);
  } finally {
    secondStore.close();
  }
});

test("managed session reconciliation is bounded and only terminalizes missing roots", async (t) => {
  const fixture = await lifecycleFixture(t);
  const store = new SqliteWorkspaceStore(fixture.stateDir);
  t.after(() => store.close());

  const activeRoot = join(fixture.worktreeRoot, "active-existing");
  await mkdir(activeRoot);
  await writeFile(join(activeRoot, "work.txt"), "still active\n");

  store.createSession({
    id: "ws_001_active",
    root: activeRoot,
    mode: "worktree",
    sourceRoot: fixture.sourceRoot,
    managed: true,
  });
  store.createSession({
    id: "ws_002_missing",
    root: join(fixture.worktreeRoot, "missing-2"),
    mode: "worktree",
    sourceRoot: fixture.sourceRoot,
    managed: true,
  });
  store.createSession({
    id: "ws_003_missing",
    root: join(fixture.worktreeRoot, "missing-3"),
    mode: "worktree",
    sourceRoot: fixture.sourceRoot,
    managed: true,
  });

  const registry = new WorkspaceRegistry(fixture.config, store);
  const first = await registry.reconcileManagedWorktreeSessions({ limit: 2 });
  assert.equal(first.checked, 2);
  assert.equal(first.reconciled, 1);
  assert.equal(first.nextCursor, "ws_002_missing");
  assert.equal(store.getSession("ws_001_active")?.status, "active");
  assert.equal(store.getSession("ws_002_missing")?.status, "missing");
  assert.equal(store.getSession("ws_003_missing")?.status, "active");

  const second = await registry.reconcileManagedWorktreeSessions({
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.equal(second.checked, 1);
  assert.equal(second.reconciled, 1);
  assert.equal(second.nextCursor, undefined);
  assert.equal(store.getSession("ws_003_missing")?.status, "missing");
  assert.equal((await stat(activeRoot)).isDirectory(), true);
});

test("release fails closed when a DevSpace process owns the workspace", async () => {
  let releaseCalls = 0;
  const workspaces = {
    releaseWorkspace: () => {
      releaseCalls += 1;
      throw new Error("release must not run while busy");
    },
  };
  const processSessions = {
    hasRunningForWorkspace: (workspaceId: string) => workspaceId === "ws_busy",
  };

  assert.throws(
    () => releaseWorkspaceLease(workspaces, processSessions, "ws_busy"),
    /still owns a running process session/,
  );
  assert.equal(releaseCalls, 0);
});

test("a process start publishes its workspace lease before the first async yield", async () => {
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 100 });
  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);

  try {
    const pending = manager.start({
      workspaceId: "ws_race",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 1000)"`,
      yieldTimeMs: 0,
    });

    assert.equal(manager.hasRunningForWorkspace("ws_race"), true);
    assert.equal(manager.hasRunningForWorkspace("ws_other"), false);

    const snapshot = await pending;
    assert.equal(snapshot.running, true);
    assert.ok(snapshot.sessionId);
    manager.terminate("ws_race", snapshot.sessionId);
  } finally {
    manager.shutdown();
  }
});
