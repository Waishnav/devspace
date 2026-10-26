import { and, asc, count, desc, eq, max, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  workspaceTurns,
  workspaceTurnToolCalls,
  type WorkspaceSessionRow,
  type WorkspaceTurnRow,
  type WorkspaceTurnToolCallRow,
} from "./db/schema.js";
import type { WorkspaceMode, WorkspaceStatus } from "./workspace-store.js";

export type WorkspaceTurnStatus = "open" | "closed";
export type WorkspaceToolCallOrigin = "model" | "card";

export interface ActivityWorkspaceRecord {
  workspaceId: string;
  root: string;
  mode: WorkspaceMode;
  status: WorkspaceStatus;
  sourceRoot?: string;
  createdAt: string;
  lastUsedAt: string;
  lastActivityAt?: string;
  turns: number;
}

export interface WorkspaceTurn {
  id: number;
  workspaceId: string;
  /** 1-based position of the turn within its workspace. */
  sequence: number;
  status: WorkspaceTurnStatus;
  /** Review checkpoint that closed the turn; absent while the turn is open. */
  reviewRef?: string;
  startedAt: string;
  closedAt?: string;
  toolCalls: number;
  failedToolCalls: number;
}

export interface WorkspaceToolCall {
  id: number;
  turnId: number;
  origin: WorkspaceToolCallOrigin;
  conversationScopeId?: string;
  requestId?: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  isError: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface RecordWorkspaceToolCall {
  turnId: number;
  origin: WorkspaceToolCallOrigin;
  conversationScopeId?: string;
  requestId?: string;
  toolName: string;
  argumentsJson: string;
  resultJson?: string;
  errorJson?: string;
  isError: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/**
 * SQLite persistence for workspace turns and the tool calls made in them.
 * A workspace has at most one open turn; a review checkpoint closes it.
 */
export class WorkspaceActivityStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string, private readonly maxTurns = Number.POSITIVE_INFINITY) {
    this.database = openDatabase(stateDir);
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.database.db
      .select({ id: workspaceSessions.id })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, workspaceId))
      .get() !== undefined;
  }

  /** Returns the workspace's open turn, starting the next one when none is open. */
  openTurn(workspaceId: string, now = new Date()): WorkspaceTurn {
    const open = this.database.sqlite.transaction(() => {
      const existing = this.findOpenTurnRow(workspaceId);
      if (existing) return existing;

      const previous = this.database.db
        .select({ sequence: max(workspaceTurns.sequence) })
        .from(workspaceTurns)
        .where(eq(workspaceTurns.workspaceSessionId, workspaceId))
        .get();
      return this.database.db
        .insert(workspaceTurns)
        .values({
          workspaceSessionId: workspaceId,
          sequence: (previous?.sequence ?? 0) + 1,
          status: "open",
          startedAt: now.toISOString(),
        })
        .returning()
        .get();
    });
    return this.withCallCounts(open.immediate());
  }

  currentTurn(workspaceId: string): WorkspaceTurn | undefined {
    const row = this.findOpenTurnRow(workspaceId);
    return row ? this.withCallCounts(row) : undefined;
  }

  /** Closes the open turn with its review checkpoint and returns it. */
  closeTurn(workspaceId: string, reviewRef: string, now = new Date()): WorkspaceTurn {
    const turn = this.openTurn(workspaceId, now);
    this.database.db
      .update(workspaceTurns)
      .set({ status: "closed", reviewRef, closedAt: now.toISOString() })
      .where(eq(workspaceTurns.id, turn.id))
      .run();
    this.pruneClosedTurns(workspaceId);
    return { ...turn, status: "closed", reviewRef, closedAt: now.toISOString() };
  }

  recordToolCall(input: RecordWorkspaceToolCall): number {
    const inserted = this.database.db
      .insert(workspaceTurnToolCalls)
      .values({
        turnId: input.turnId,
        origin: input.origin,
        conversationScopeId: input.conversationScopeId ?? null,
        requestId: input.requestId ?? null,
        toolName: input.toolName,
        argumentsJson: input.argumentsJson,
        resultJson: input.resultJson ?? null,
        errorJson: input.errorJson ?? null,
        isError: input.isError ? 1 : 0,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
      })
      .run();
    return Number(inserted.lastInsertRowid);
  }

  /** Lists workspaces, most recently active first. */
  listWorkspaces(): ActivityWorkspaceRecord[] {
    return this.workspaceQuery().all().map(rowToWorkspace);
  }

  getWorkspace(workspaceId: string): ActivityWorkspaceRecord | undefined {
    const row = this.workspaceQuery().where(eq(workspaceSessions.id, workspaceId)).get();
    return row ? rowToWorkspace(row) : undefined;
  }

  private workspaceQuery() {
    const activity = this.database.db
      .select({
        workspaceId: workspaceTurns.workspaceSessionId,
        turns: sql<number>`count(distinct ${workspaceTurns.id})`.as("turns"),
        lastActivityAt: max(workspaceTurnToolCalls.completedAt).as("last_activity_at"),
      })
      .from(workspaceTurns)
      .leftJoin(workspaceTurnToolCalls, eq(workspaceTurnToolCalls.turnId, workspaceTurns.id))
      .groupBy(workspaceTurns.workspaceSessionId)
      .as("activity");

    return this.database.db
      .select({
        session: workspaceSessions,
        turns: activity.turns,
        lastActivityAt: activity.lastActivityAt,
      })
      .from(workspaceSessions)
      .leftJoin(activity, eq(activity.workspaceId, workspaceSessions.id))
      .orderBy(desc(sql`coalesce(${activity.lastActivityAt}, ${workspaceSessions.lastUsedAt})`))
      .$dynamic();
  }

  /** Lists a workspace's turns, latest first. */
  listTurns(workspaceId: string): WorkspaceTurn[] {
    return this.turnQuery()
      .where(eq(workspaceTurns.workspaceSessionId, workspaceId))
      .orderBy(desc(workspaceTurns.sequence))
      .all()
      .map(rowToTurn);
  }

  getTurn(workspaceId: string, sequence: number): WorkspaceTurn | undefined {
    const row = this.turnQuery()
      .where(and(
        eq(workspaceTurns.workspaceSessionId, workspaceId),
        eq(workspaceTurns.sequence, sequence),
      ))
      .get();
    return row ? rowToTurn(row) : undefined;
  }

  /** Lists the tool calls of one turn in the order they started. */
  listToolCalls(turnId: number): WorkspaceToolCall[] {
    return this.database.db
      .select()
      .from(workspaceTurnToolCalls)
      .where(eq(workspaceTurnToolCalls.turnId, turnId))
      .orderBy(asc(workspaceTurnToolCalls.startedAt), asc(workspaceTurnToolCalls.id))
      .all()
      .map(rowToToolCall);
  }

  close(): void {
    this.database.close();
  }

  /** Keeps the newest `maxTurns` closed turns; their tool calls cascade. */
  private pruneClosedTurns(workspaceId: string): void {
    if (!Number.isFinite(this.maxTurns)) return;
    this.database.sqlite.prepare(`
      delete from workspace_turns
      where workspace_session_id = ? and status = 'closed' and id not in (
        select id from workspace_turns
        where workspace_session_id = ? and status = 'closed'
        order by sequence desc
        limit ?
      )
    `).run(workspaceId, workspaceId, this.maxTurns);
  }

  private findOpenTurnRow(workspaceId: string): WorkspaceTurnRow | undefined {
    return this.database.db
      .select()
      .from(workspaceTurns)
      .where(and(
        eq(workspaceTurns.workspaceSessionId, workspaceId),
        eq(workspaceTurns.status, "open"),
      ))
      .get();
  }

  private withCallCounts(row: WorkspaceTurnRow): WorkspaceTurn {
    const counts = this.turnQuery().where(eq(workspaceTurns.id, row.id)).get();
    return counts ? rowToTurn(counts) : rowToTurn({ turn: row, toolCalls: 0, failedToolCalls: 0 });
  }

  private turnQuery() {
    return this.database.db
      .select({
        turn: workspaceTurns,
        toolCalls: count(workspaceTurnToolCalls.id),
        failedToolCalls: sql<number>`coalesce(sum(${workspaceTurnToolCalls.isError}), 0)`,
      })
      .from(workspaceTurns)
      .leftJoin(workspaceTurnToolCalls, eq(workspaceTurnToolCalls.turnId, workspaceTurns.id))
      .groupBy(workspaceTurns.id)
      .$dynamic();
  }
}

function rowToWorkspace({ session, turns, lastActivityAt }: {
  session: WorkspaceSessionRow;
  turns: number | null;
  lastActivityAt: string | null;
}): ActivityWorkspaceRecord {
  return {
    workspaceId: session.id,
    root: session.root,
    mode: session.mode as WorkspaceMode,
    status: session.status as WorkspaceStatus,
    ...(session.sourceRoot ? { sourceRoot: session.sourceRoot } : {}),
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    turns: turns ?? 0,
  };
}

function rowToTurn(row: {
  turn: WorkspaceTurnRow;
  toolCalls: number;
  failedToolCalls: number;
}): WorkspaceTurn {
  const { turn } = row;
  return {
    id: turn.id,
    workspaceId: turn.workspaceSessionId,
    sequence: turn.sequence,
    status: turn.status as WorkspaceTurnStatus,
    ...(turn.reviewRef ? { reviewRef: turn.reviewRef } : {}),
    startedAt: turn.startedAt,
    ...(turn.closedAt ? { closedAt: turn.closedAt } : {}),
    toolCalls: row.toolCalls,
    failedToolCalls: Number(row.failedToolCalls),
  };
}

function rowToToolCall(row: WorkspaceTurnToolCallRow): WorkspaceToolCall {
  return {
    id: row.id,
    turnId: row.turnId,
    origin: row.origin as WorkspaceToolCallOrigin,
    ...(row.conversationScopeId ? { conversationScopeId: row.conversationScopeId } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    toolName: row.toolName,
    arguments: JSON.parse(row.argumentsJson) as unknown,
    ...(row.resultJson ? { result: JSON.parse(row.resultJson) as unknown } : {}),
    ...(row.errorJson ? { error: JSON.parse(row.errorJson) as unknown } : {}),
    isError: row.isError === 1,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
  };
}
