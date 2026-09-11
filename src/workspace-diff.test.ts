import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { listWorkspaceRefs, readWorkspaceDiff } from "./workspace-diff.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("workspace diff supports review, working tree, branch, and exact ref comparisons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-diff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);

  const workspace = testWorkspace(root);
  const checkpoints = createReviewCheckpointManager();
  await checkpoints.initializeWorkspace({ workspaceId: workspace.id, root });

  await git(root, ["switch", "-c", "feature"]);
  await writeFile(join(root, "README.md"), "feature\n");
  await git(root, ["commit", "-am", "feature"]);
  const branch = await readWorkspaceDiff(workspace, checkpoints, { kind: "branch", baseRef: "main" });
  assert.match(branch.patch, /-base\n\+feature/);

  await writeFile(join(root, "new.txt"), "untracked\n");
  const workingTree = await readWorkspaceDiff(workspace, checkpoints, { kind: "working-tree" });
  assert.match(workingTree.patch, /new\.txt/);

  const compare = await readWorkspaceDiff(workspace, checkpoints, {
    kind: "compare",
    fromRef: "main",
    toRef: "feature",
  });
  assert.match(compare.patch, /-base\n\+feature/);

  await writeFile(join(root, "README.md"), "reviewed\n");
  const review = await checkpoints.reviewChanges({ workspaceId: workspace.id, root });
  const historical = await readWorkspaceDiff(workspace, checkpoints, {
    kind: "review",
    reviewRef: review.reviewRef,
  });
  assert.equal(historical.patch, review.patch);

  const refs = await listWorkspaceRefs(workspace);
  assert.equal(refs.currentRef, "feature");
  assert.ok(refs.refs.includes("main"));
  assert.ok(refs.refs.includes("feature"));
});

function testWorkspace(root: string): Workspace {
  return {
    id: "ws_diff",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    agentProfiles: [],
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
