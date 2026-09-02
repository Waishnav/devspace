import { and, asc, eq, gt } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceConversationBindings,
  workspaceSessions,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";
export type WorkspaceSessionStatus = "active" | "released" | "missing" | "unknown";
type TerminalWorkspaceSessionStatus = "released" | "missing";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: WorkspaceSessionStatus;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
  terminalAt?: string;
  terminalReason?: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  releaseSession(id: string, reason?: string): WorkspaceSession | undefined;
  markSessionMissing(id: string, reason?: string): WorkspaceSession | undefined;
  listActiveManagedSessions(input?: {
    afterId?: string;
    limit?: number;
  }): WorkspaceSession[];
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBindingsForWorkspace(workspaceSessionId: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        terminalAt: null,
        terminalReason: null,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "active"),
        ),
      )
      .run();
  }

  releaseSession(id: string, reason = "explicit_release"): WorkspaceSession | undefined {
    return this.transitionSession(id, "released", reason);
  }

  markSessionMissing(id: string, reason = "managed_worktree_missing"): WorkspaceSession | undefined {
    return this.transitionSession(id, "missing", reason);
  }

  listActiveManagedSessions(
    input: { afterId?: string; limit?: number } = {},
  ): WorkspaceSession[] {
    const limit = input.limit ?? 128;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new Error("Managed workspace reconciliation limit must be an integer between 1 and 512.");
    }

    const activeManaged = and(
      eq(workspaceSessions.status, "active"),
      eq(workspaceSessions.mode, "worktree"),
      eq(workspaceSessions.managed, "true"),
    );
    const condition = input.afterId
      ? and(activeManaged, gt(workspaceSessions.id, input.afterId))
      : activeManaged;
    const rows = this.database.db
      .select()
      .from(workspaceSessions)
      .where(condition)
      .orderBy(asc(workspaceSessions.id))
      .limit(limit)
      .all();

    return rows.map(rowToWorkspaceSession);
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBindingsForWorkspace(workspaceSessionId: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(eq(workspaceConversationBindings.workspaceSessionId, workspaceSessionId))
      .run();
  }

  close(): void {
    this.database.close();
  }

  private transitionSession(
    id: string,
    status: TerminalWorkspaceSessionStatus,
    reason: string,
  ): WorkspaceSession | undefined {
    const now = new Date().toISOString();
    const row = this.database.db
      .update(workspaceSessions)
      .set({
        status,
        terminalAt: now,
        terminalReason: reason,
      })
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "active"),
        ),
      )
      .returning()
      .get();

    return row ? rowToWorkspaceSession(row) : this.getSession(id);
  }
}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: workspaceSessionStatus(row.status),
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    terminalAt: row.terminalAt ?? undefined,
    terminalReason: row.terminalReason ?? undefined,
  };
}

function workspaceSessionStatus(status: string): WorkspaceSessionStatus {
  if (status === "active" || status === "released" || status === "missing") {
    return status;
  }
  // Legacy or unexpected states are never treated as an active reusable lease,
  // but they also do not constitute explicit release authority for GC.
  return "unknown";
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
