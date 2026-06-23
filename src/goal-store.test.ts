import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGoalStore, validateObjective } from "./goal-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));

try {
  testObjectiveValidation();
  testGoalLifecycle(join(root, "lifecycle"));
  testGoalPersistence(join(root, "persistence"));
} finally {
  await rm(root, { recursive: true, force: true });
}

function testObjectiveValidation(): void {
  assert.equal(validateObjective("  ship goals  "), "ship goals");
  assert.throws(() => validateObjective("   "), /Goal objective must not be empty/);
  assert.throws(() => validateObjective("x".repeat(4001)), /must not exceed 4000/);
}

function testGoalLifecycle(stateDir: string): void {
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const goalStore = new SqliteGoalStore(stateDir);
  try {
    const workspace = workspaceStore.createSession({ id: "ws_1", root: process.cwd() });
    assert.equal(goalStore.getGoal(workspace.id), undefined);

    const goal = goalStore.createGoal({ workspaceId: workspace.id, objective: "  implement workspace goals  " });
    assert.equal(goal.workspaceId, workspace.id);
    assert.equal(goal.objective, "implement workspace goals");
    assert.equal(goal.status, "active");
    assert.ok(goal.goalId);

    assert.throws(
      () => goalStore.createGoal({ workspaceId: workspace.id, objective: "replace too early" }),
      /unfinished goal already exists/,
    );

    const blocked = goalStore.updateGoal({ workspaceId: workspace.id, status: "blocked" });
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.completedAt, undefined);

    const complete = goalStore.updateGoal({ workspaceId: workspace.id, status: "complete" });
    assert.equal(complete?.status, "complete");
    assert.ok(complete?.completedAt);

    const replacement = goalStore.createGoal({ workspaceId: workspace.id, objective: "next goal" });
    assert.equal(replacement.status, "active");
    assert.equal(replacement.objective, "next goal");
    assert.notEqual(replacement.goalId, goal.goalId);
  } finally {
    goalStore.close();
    workspaceStore.close();
  }
}

function testGoalPersistence(stateDir: string): void {
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const firstGoalStore = new SqliteGoalStore(stateDir);
  const workspace = workspaceStore.createSession({ id: "ws_2", root: process.cwd() });
  const created = firstGoalStore.createGoal({ workspaceId: workspace.id, objective: "persist me" });
  firstGoalStore.close();
  workspaceStore.close();

  const secondGoalStore = new SqliteGoalStore(stateDir);
  try {
    assert.deepEqual(secondGoalStore.getGoal(workspace.id), created);
    assert.equal(secondGoalStore.updateGoal({ workspaceId: "missing", status: "complete" }), undefined);
  } finally {
    secondGoalStore.close();
  }
}
