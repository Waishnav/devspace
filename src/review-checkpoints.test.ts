import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager, readReviewRef } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("a clean workspace reports no changes from the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_clean", root });
  const clean = await manager.reviewChanges({ workspaceId: "ws_clean", root });

  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
});

test("initialization reports whether aggregate review is available", async (t) => {
  const gitRoot = await committedRepository(t);
  const plainRoot = await mkdtemp(join(tmpdir(), "devspace-review-plain-test-"));
  t.after(() => rm(plainRoot, { recursive: true, force: true }));
  const manager = createReviewCheckpointManager();

  assert.deepEqual(
    await manager.initializeWorkspace({ workspaceId: "ws_git", root: gitRoot }),
    { available: true },
  );
  const unavailable = await manager.initializeWorkspace({
    workspaceId: "ws_plain",
    root: plainRoot,
  });
  assert.equal(unavailable.available, false);
  if (!unavailable.available) assert.match(unavailable.reason, /git repository/i);
});

test("show_changes reports and advances the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_incremental", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const unreviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: false,
  });
  assert.deepEqual(unreviewed.files.map((file) => file.path).sort(), ["README.md", "new.txt"]);
  assert.equal(unreviewed.summary.additions, 2);
  assert.match(unreviewed.patch, /world/);

  const markedReviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: true,
  });
  assert.equal(markedReviewed.summary.files, 2);
  assert.match(markedReviewed.reviewRef, /^[0-9a-f]{40,64}$/);

  const restored = await manager.reviewByRef({
    workspaceId: "ws_incremental",
    root,
    reviewRef: markedReviewed.reviewRef,
  });
  assert.deepEqual(restored.summary, markedReviewed.summary);
  assert.deepEqual(restored.files, markedReviewed.files);
  assert.equal(restored.patch, markedReviewed.patch);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_incremental", root });
  assert.equal(afterReviewed.summary.files, 0);
  assert.equal(afterReviewed.patch, "");
});

test("historical review refs survive later reviews and manager restarts", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\n");
  const first = await manager.reviewChanges({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\nsecond\n");
  const second = await manager.reviewChanges({ workspaceId: "ws_history", root });
  assert.notEqual(first.reviewRef, second.reviewRef);

  const restarted = createReviewCheckpointManager();
  const restoredFirst = await restarted.reviewByRef({
    workspaceId: "ws_history",
    root,
    reviewRef: first.reviewRef,
  });
  assert.deepEqual(restoredFirst.summary, first.summary);
  assert.equal(restoredFirst.patch, first.patch);
  assert.match(restoredFirst.patch, /\+first/);
  assert.doesNotMatch(restoredFirst.patch, /\+second/);
});

test("review refs are scoped to the workspace review history", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_scoped", root });

  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    () => manager.reviewByRef({ workspaceId: "ws_scoped", root, reviewRef: head }),
    /Unknown review reference/,
  );
  await assert.rejects(
    () => readReviewRef(root, head),
    /Unknown DevSpace review reference/,
  );
});

test("review checkpoints survive a manager restart", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_restart", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await manager.reviewChanges({ workspaceId: "ws_restart", root, markReviewed: true });

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_restart", root });
  await writeFile(join(root, "later.txt"), "after restart\n");

  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_restart",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterRestart.files.map((file) => file.path), ["later.txt"]);
  assert.match(afterRestart.patch, /after restart/);
  assert.doesNotMatch(afterRestart.patch, /world/);
});

test("concurrent initialization produces one usable checkpoint state", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [, concurrentReview] = await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent", root }),
    manager.reviewChanges({ workspaceId: "ws_concurrent", root, markReviewed: false }),
  ]);
  assert.equal(concurrentReview.summary.files, 0);

  await writeFile(join(root, "later.txt"), "visible after initialization\n");
  const afterInitialization = await manager.reviewChanges({
    workspaceId: "ws_concurrent",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterInitialization.files.map((file) => file.path), ["later.txt"]);
});

test("a missing last-shown checkpoint falls back after restart and can be re-established", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  await writeFile(join(root, "README.md"), "hello\nchanged\n");
  await deleteReviewRef(root, "ws_missing_baseline", "baseline");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  const fallback = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(fallback.summary.files, 1);
  assert.match(fallback.patch, /changed/);

  const reestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: true,
  });
  assert.equal(reestablished.summary.files, 1);

  const afterReestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(afterReestablished.summary.files, 0);
});

test("a checkpoint workspace rejects a different root without changing its state", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_root_mismatch", root });

  await assert.rejects(
    () => manager.reviewChanges({
      workspaceId: "ws_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
    /workspace root mismatch/,
  );

  await writeFile(join(root, "only-first-root.txt"), "first root\n");
  const review = await manager.reviewChanges({
    workspaceId: "ws_root_mismatch",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["only-first-root.txt"]);
});

test("a concurrent review rejects a different root after initialization", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [initialization, review] = await Promise.allSettled([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent_root_mismatch", root }),
    manager.reviewChanges({
      workspaceId: "ws_concurrent_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
  ]);

  assert.equal(initialization.status, "fulfilled");
  assert.equal(review.status, "rejected");
  if (review.status === "rejected") {
    assert.match(String(review.reason), /workspace root mismatch/);
  }
});

test("an unborn repository is reviewable without creating a HEAD commit", async (t) => {
  const root = await unbornRepository(t);
  await writeFile(join(root, "existing.txt"), "present at open\n");
  const manager = createReviewCheckpointManager();

  const availability = await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });
  assert.deepEqual(availability, { available: true });
  await assert.rejects(() => git(root, ["rev-parse", "--verify", "HEAD^{commit}"]));

  await writeFile(join(root, "created-after-open.txt"), "new file\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["created-after-open.txt"]);
  assert.equal(review.files[0]?.type, "new");
  assert.match(review.patch, /new file/);
});

async function committedRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

async function unbornRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-unborn-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  return root;
}

async function deleteReviewRef(
  root: string,
  workspaceId: string,
  checkpoint: "open" | "baseline",
): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/devspace/review/${workspaceId}/${checkpoint}`]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
