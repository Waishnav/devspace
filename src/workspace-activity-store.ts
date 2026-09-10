import { and, desc, eq, lt } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions, workspaceToolCalls, type WorkspaceToolCallRow } from "./db/schema.js";

export interface WorkspaceToolCallSummary {
  id: number;
  workspaceId?: string;
  conversationScopeId?: string;
  requestId?: string;
  toolName: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  reviewRef?: string;
}

export interface WorkspaceToolCall extends WorkspaceToolCallSummary {
  arguments: unknown;
  result?: unknown;
  error?: unknown;
}

export interface StartWorkspaceToolCall {
  workspaceId?: string;
  conversationScopeId?: string;
  requestId?: string;
  toolName: string;
  arguments: unknown;
  startedAt: string;
}

export interface FinishWorkspaceToolCall {
  workspaceId?: string;
  result?: unknown;
  error?: unknown;
  completedAt: string;
  durationMs: number;
  reviewRef?: string;
}

export class WorkspaceActivityStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  startCall(input: StartWorkspaceToolCall): number {
    const inserted = this.database.db
      .insert(workspaceToolCalls)
      .values({
        workspaceSessionId: this.existingWorkspaceId(input.workspaceId) ?? null,
        conversationScopeId: input.conversationScopeId ?? null,
        requestId: input.requestId ?? null,
        toolName: input.toolName,
        argumentsJson: JSON.stringify(input.arguments),
        startedAt: input.startedAt,
      })
      .run();

    return Number(inserted.lastInsertRowid);
  }

  finishCall(id: number, input: FinishWorkspaceToolCall): void {
    this.database.db
      .update(workspaceToolCalls)
      .set({
        ...(input.workspaceId
          ? { workspaceSessionId: this.existingWorkspaceId(input.workspaceId) ?? null }
          : {}),
        resultJson: input.result === undefined ? null : JSON.stringify(input.result),
        errorJson: input.error === undefined ? null : JSON.stringify(input.error),
        completedAt: input.completedAt,
        durationMs: input.durationMs,
        reviewRef: input.reviewRef ?? null,
      })
      .where(eq(workspaceToolCalls.id, id))
      .run();
  }

  listCalls(input: {
    workspaceId: string;
    beforeId?: number;
    limit: number;
  }): WorkspaceToolCall[] {
    const clauses = [eq(workspaceToolCalls.workspaceSessionId, input.workspaceId)];
    if (input.beforeId !== undefined) clauses.push(lt(workspaceToolCalls.id, input.beforeId));

    return this.database.db
      .select()
      .from(workspaceToolCalls)
      .where(and(...clauses))
      .orderBy(desc(workspaceToolCalls.id))
      .limit(input.limit)
      .all()
      .map(rowToWorkspaceToolCall);
  }

  listCallSummaries(input: {
    workspaceId: string;
    beforeId?: number;
    limit: number;
  }): WorkspaceToolCallSummary[] {
    const clauses = [eq(workspaceToolCalls.workspaceSessionId, input.workspaceId)];
    if (input.beforeId !== undefined) clauses.push(lt(workspaceToolCalls.id, input.beforeId));

    return this.database.db
      .select({
        id: workspaceToolCalls.id,
        workspaceSessionId: workspaceToolCalls.workspaceSessionId,
        conversationScopeId: workspaceToolCalls.conversationScopeId,
        requestId: workspaceToolCalls.requestId,
        toolName: workspaceToolCalls.toolName,
        startedAt: workspaceToolCalls.startedAt,
        completedAt: workspaceToolCalls.completedAt,
        durationMs: workspaceToolCalls.durationMs,
        reviewRef: workspaceToolCalls.reviewRef,
      })
      .from(workspaceToolCalls)
      .where(and(...clauses))
      .orderBy(desc(workspaceToolCalls.id))
      .limit(input.limit)
      .all()
      .map(rowToWorkspaceToolCallSummary);
  }

  getCall(workspaceId: string, callId: number): WorkspaceToolCall | undefined {
    const row = this.database.db
      .select()
      .from(workspaceToolCalls)
      .where(
        and(
          eq(workspaceToolCalls.workspaceSessionId, workspaceId),
          eq(workspaceToolCalls.id, callId),
        ),
      )
      .get();
    return row ? rowToWorkspaceToolCall(row) : undefined;
  }

  findCallSummaryByReviewRef(
    workspaceId: string,
    reviewRef: string,
  ): WorkspaceToolCallSummary | undefined {
    const row = this.database.db
      .select({
        id: workspaceToolCalls.id,
        workspaceSessionId: workspaceToolCalls.workspaceSessionId,
        conversationScopeId: workspaceToolCalls.conversationScopeId,
        requestId: workspaceToolCalls.requestId,
        toolName: workspaceToolCalls.toolName,
        startedAt: workspaceToolCalls.startedAt,
        completedAt: workspaceToolCalls.completedAt,
        durationMs: workspaceToolCalls.durationMs,
        reviewRef: workspaceToolCalls.reviewRef,
      })
      .from(workspaceToolCalls)
      .where(
        and(
          eq(workspaceToolCalls.workspaceSessionId, workspaceId),
          eq(workspaceToolCalls.reviewRef, reviewRef),
        ),
      )
      .get();
    return row ? rowToWorkspaceToolCallSummary(row) : undefined;
  }

  close(): void {
    this.database.close();
  }

  private existingWorkspaceId(workspaceId: string | undefined): string | undefined {
    if (!workspaceId) return undefined;
    const row = this.database.db
      .select({ id: workspaceSessions.id })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, workspaceId))
      .get();
    return row?.id;
  }
}

function rowToWorkspaceToolCall(row: WorkspaceToolCallRow): WorkspaceToolCall {
  return {
    ...rowToWorkspaceToolCallSummary(row),
    arguments: JSON.parse(row.argumentsJson) as unknown,
    ...(row.resultJson ? { result: JSON.parse(row.resultJson) as unknown } : {}),
    ...(row.errorJson ? { error: JSON.parse(row.errorJson) as unknown } : {}),
  };
}

function rowToWorkspaceToolCallSummary(
  row: Pick<
    WorkspaceToolCallRow,
    | "id"
    | "workspaceSessionId"
    | "conversationScopeId"
    | "requestId"
    | "toolName"
    | "startedAt"
    | "completedAt"
    | "durationMs"
    | "reviewRef"
  >,
): WorkspaceToolCallSummary {
  return {
    id: row.id,
    ...(row.workspaceSessionId ? { workspaceId: row.workspaceSessionId } : {}),
    ...(row.conversationScopeId ? { conversationScopeId: row.conversationScopeId } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    toolName: row.toolName,
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.reviewRef ? { reviewRef: row.reviewRef } : {}),
  };
}
