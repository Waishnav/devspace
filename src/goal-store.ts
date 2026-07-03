import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceGoals, type WorkspaceGoalRow } from "./db/schema.js";

export const goalStatuses = ["active", "paused", "blocked", "complete", "cancelled"] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export interface WorkspaceGoal {
  workspaceSessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  progressSummary: string;
  nextStep: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SetGoalInput {
  workspaceSessionId: string;
  objective: string;
  progressSummary?: string;
  nextStep?: string;
}

export interface UpdateGoalInput {
  workspaceSessionId: string;
  status?: GoalStatus;
  progressSummary?: string;
  nextStep?: string;
}

export interface GoalStore {
  getGoal(workspaceSessionId: string): WorkspaceGoal | undefined;
  setGoal(input: SetGoalInput): WorkspaceGoal;
  updateGoal(input: UpdateGoalInput): WorkspaceGoal | undefined;
  clearGoal(workspaceSessionId: string): boolean;
  close?(): void;
}

export class SqliteGoalStore implements GoalStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  getGoal(workspaceSessionId: string): WorkspaceGoal | undefined {
    const row = this.database.db
      .select()
      .from(workspaceGoals)
      .where(eq(workspaceGoals.workspaceSessionId, workspaceSessionId))
      .get();

    return row ? rowToWorkspaceGoal(row) : undefined;
  }

  setGoal(input: SetGoalInput): WorkspaceGoal {
    const now = new Date().toISOString();
    const goal: WorkspaceGoal = {
      workspaceSessionId: input.workspaceSessionId,
      goalId: `goal_${randomUUID()}`,
      objective: input.objective.trim(),
      status: "active",
      progressSummary: input.progressSummary?.trim() ?? "",
      nextStep: input.nextStep?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    };

    if (!goal.objective) {
      throw new Error("Goal objective must not be empty.");
    }

    const replaceGoal = this.database.sqlite.transaction(() => {
      this.database.db
        .delete(workspaceGoals)
        .where(eq(workspaceGoals.workspaceSessionId, input.workspaceSessionId))
        .run();
      this.database.db
        .insert(workspaceGoals)
        .values({
          workspaceSessionId: goal.workspaceSessionId,
          goalId: goal.goalId,
          objective: goal.objective,
          status: goal.status,
          progressSummary: goal.progressSummary,
          nextStep: goal.nextStep,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
          completedAt: null,
        })
        .run();
    });
    replaceGoal.immediate();

    return goal;
  }

  updateGoal(input: UpdateGoalInput): WorkspaceGoal | undefined {
    const existing = this.getGoal(input.workspaceSessionId);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const status = input.status ?? existing.status;
    const completedAt = status === "complete"
      ? existing.completedAt ?? now
      : undefined;

    this.database.db
      .update(workspaceGoals)
      .set({
        status,
        progressSummary: input.progressSummary?.trim() ?? existing.progressSummary,
        nextStep: input.nextStep?.trim() ?? existing.nextStep,
        updatedAt: now,
        completedAt: completedAt ?? null,
      })
      .where(eq(workspaceGoals.workspaceSessionId, input.workspaceSessionId))
      .run();

    return this.getGoal(input.workspaceSessionId);
  }

  clearGoal(workspaceSessionId: string): boolean {
    const result = this.database.db
      .delete(workspaceGoals)
      .where(eq(workspaceGoals.workspaceSessionId, workspaceSessionId))
      .run();

    return result.changes > 0;
  }

  close(): void {
    this.database.close();
  }
}

export function createGoalStore(stateDir: string): GoalStore {
  return new SqliteGoalStore(stateDir);
}

function rowToWorkspaceGoal(row: WorkspaceGoalRow): WorkspaceGoal {
  return {
    workspaceSessionId: row.workspaceSessionId,
    goalId: row.goalId,
    objective: row.objective,
    status: parseGoalStatus(row.status),
    progressSummary: row.progressSummary,
    nextStep: row.nextStep,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function parseGoalStatus(status: string): GoalStatus {
  if (goalStatuses.includes(status as GoalStatus)) return status as GoalStatus;
  return "active";
}
