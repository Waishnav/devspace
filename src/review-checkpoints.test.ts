import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("a clean workspace reports no changes from the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_clean", root });
  const clean = await manager.reviewChanges({ workspaceId: "ws_clean", root });

  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes since last shown changes/);
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

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_incremental", root });
  assert.equal(afterReviewed.summary.files, 0);
  assert.equal(afterReviewed.patch, "");
});

test("a nested workspace only reviews changes inside its workspace root", async (t) => {
  const repositoryRoot = await committedRepository(t);
  const workspaceRoot = join(repositoryRoot, "packages", "app");
  const siblingRoot = join(repositoryRoot, "packages", "other");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(siblingRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "app.txt"), "app\n");
  await writeFile(join(siblingRoot, "other.txt"), "other\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "Add packages"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_nested", root: workspaceRoot });

  await writeFile(join(workspaceRoot, "app.txt"), "app changed\n");
  await writeFile(join(siblingRoot, "other.txt"), "other changed\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_nested",
    root: workspaceRoot,
    markReviewed: false,
  });

  assert.deepEqual(review.files.map((file) => file.path), ["app.txt"]);
  assert.match(review.patch, /app changed/);
  assert.doesNotMatch(review.patch, /other changed/);
});

test("binary changes use a renderable review patch instead of a Git binary patch", async (t) => {
  const root = await committedRepository(t);
  await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
  await git(root, ["add", "asset.bin"]);
  await git(root, ["commit", "-m", "Add binary asset"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_binary", root });
  await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 9, 3]));

  const review = await manager.reviewChanges({
    workspaceId: "ws_binary",
    root,
    markReviewed: false,
  });

  assert.deepEqual(review.files.map((file) => file.path), ["asset.bin"]);
  assert.match(review.patch, /Binary files/);
  assert.doesNotMatch(review.patch, /GIT binary patch/);
});

test("review metadata preserves pure renames from the rendered patch", async (t) => {
  const root = await committedRepository(t);
  await writeFile(join(root, "before.txt"), "same content\n");
  await git(root, ["add", "before.txt"]);
  await git(root, ["commit", "-m", "Add rename source"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_rename", root });
  await rename(join(root, "before.txt"), join(root, "after.txt"));

  const review = await manager.reviewChanges({
    workspaceId: "ws_rename",
    root,
    markReviewed: false,
  });

  assert.deepEqual(review.files, [
    {
      path: "after.txt",
      previousPath: "before.txt",
      type: "rename-pure",
      additions: 0,
      removals: 0,
    },
  ]);
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
  assert.match(fallback.result, /compared from workspace open/);
  assert.match(fallback.patch, /changed/);

  const reestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: true,
  });
  assert.equal(reestablished.summary.files, 1);
  assert.match(reestablished.result, /baseline was re-established/);

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

test("an unborn repository is reviewable without creating a commit", async (t) => {
  const root = await unbornRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });
  await writeFile(join(root, "README.md"), "first file\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["README.md"]);
  assert.equal(review.files[0]?.type, "new");
  assert.match(review.patch, /first file/);
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
