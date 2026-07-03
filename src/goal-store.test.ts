import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGoalStore } from "./goal-store.js";
import { SqliteWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));

try {
  const stateDir = join(root, ".state");
  const workspaceStore: WorkspaceStore = new SqliteWorkspaceStore(stateDir);
  const goalStore = new SqliteGoalStore(stateDir);
  const workspace = workspaceStore.createSession({
    id: "ws_goal_store_test",
    root: join(root, "project"),
  });

  assert.equal(goalStore.getGoal(workspace.id), undefined);

  const created = goalStore.setGoal({
    workspaceSessionId: workspace.id,
    objective: "Ship workspace goals",
    progressSummary: "Schema exists",
    nextStep: "Wire tools",
  });
  assert.equal(created.workspaceSessionId, workspace.id);
  assert.equal(created.objective, "Ship workspace goals");
  assert.equal(created.status, "active");
  assert.equal(created.completedAt, undefined);

  assert.deepEqual(goalStore.getGoal(workspace.id), created);

  const updated = goalStore.updateGoal({
    workspaceSessionId: workspace.id,
    progressSummary: "Tools wired",
    nextStep: "Document behavior",
  });
  assert.equal(updated?.status, "active");
  assert.equal(updated?.progressSummary, "Tools wired");
  assert.equal(updated?.nextStep, "Document behavior");
  assert.notEqual(updated?.updatedAt, created.updatedAt);

  const completed = goalStore.updateGoal({
    workspaceSessionId: workspace.id,
    status: "complete",
  });
  assert.equal(completed?.status, "complete");
  assert.ok(completed?.completedAt);

  const replacement = goalStore.setGoal({
    workspaceSessionId: workspace.id,
    objective: "Replacement goal",
  });
  assert.equal(replacement.status, "active");
  assert.equal(replacement.progressSummary, "");
  assert.equal(replacement.nextStep, "");
  assert.notEqual(replacement.goalId, created.goalId);

  assert.equal(goalStore.updateGoal({ workspaceSessionId: "missing", status: "blocked" }), undefined);
  assert.equal(goalStore.clearGoal(workspace.id), true);
  assert.equal(goalStore.clearGoal(workspace.id), false);
  assert.equal(goalStore.getGoal(workspace.id), undefined);

  assert.throws(
    () => goalStore.setGoal({ workspaceSessionId: workspace.id, objective: "   " }),
    /Goal objective must not be empty/,
  );

  goalStore.close();
  workspaceStore.close?.();
} finally {
  await rm(root, { recursive: true, force: true });
}
