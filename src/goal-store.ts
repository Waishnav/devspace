import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceGoals, type WorkspaceGoalRow } from "./db/schema.js";

export type GoalStatus = "active" | "blocked" | "complete";
export type ModelSettableGoalStatus = "blocked" | "complete";

export interface WorkspaceGoal {
  workspaceId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GoalStore {
  getGoal(workspaceId: string): WorkspaceGoal | undefined;
  createGoal(input: { workspaceId: string; objective: string }): WorkspaceGoal;
  updateGoal(input: { workspaceId: string; status: ModelSettableGoalStatus }): WorkspaceGoal | undefined;
  close?(): void;
}

export class SqliteGoalStore implements GoalStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  getGoal(workspaceId: string): WorkspaceGoal | undefined {
    const row = this.database.db
      .select()
      .from(workspaceGoals)
      .where(eq(workspaceGoals.workspaceSessionId, workspaceId))
      .get();

    return row ? rowToWorkspaceGoal(row) : undefined;
  }

  createGoal(input: { workspaceId: string; objective: string }): WorkspaceGoal {
    const objective = validateObjective(input.objective);
    const existing = this.getGoal(input.workspaceId);
    if (existing && existing.status !== "complete") {
      throw new Error("An unfinished goal already exists for this workspace. Use update_goal to change its status.");
    }

    const now = new Date().toISOString();
    const goal: WorkspaceGoal = {
      workspaceId: input.workspaceId,
      goalId: randomUUID(),
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    this.database.db
      .insert(workspaceGoals)
      .values({
        workspaceSessionId: goal.workspaceId,
        goalId: goal.goalId,
        objective: goal.objective,
        status: goal.status,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        completedAt: null,
      })
      .onConflictDoUpdate({
        target: workspaceGoals.workspaceSessionId,
        set: {
          goalId: goal.goalId,
          objective: goal.objective,
          status: goal.status,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
          completedAt: null,
        },
      })
      .run();

    return goal;
  }

  updateGoal(input: { workspaceId: string; status: ModelSettableGoalStatus }): WorkspaceGoal | undefined {
    const existing = this.getGoal(input.workspaceId);
    if (!existing) return undefined;
    if (existing.status === "complete") return existing;

    const now = new Date().toISOString();
    this.database.db
      .update(workspaceGoals)
      .set({
        status: input.status,
        updatedAt: now,
        completedAt: input.status === "complete" ? now : null,
      })
      .where(eq(workspaceGoals.workspaceSessionId, input.workspaceId))
      .run();

    return this.getGoal(input.workspaceId);
  }

  close(): void {
    this.database.close();
  }
}

export function createGoalStore(stateDir: string): GoalStore {
  return new SqliteGoalStore(stateDir);
}

export function validateObjective(value: string): string {
  const objective = value.trim();
  if (!objective) {
    throw new Error("Goal objective must not be empty.");
  }
  if (objective.length > 4000) {
    throw new Error("Goal objective must not exceed 4000 characters.");
  }
  return objective;
}

function rowToWorkspaceGoal(row: WorkspaceGoalRow): WorkspaceGoal {
  const goal: WorkspaceGoal = {
    workspaceId: row.workspaceSessionId,
    goalId: row.goalId,
    objective: row.objective,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.completedAt) goal.completedAt = row.completedAt;
  return goal;
}
