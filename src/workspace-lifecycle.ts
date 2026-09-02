import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";
import { WorkspaceRegistry } from "./workspaces.js";

const RECONCILIATION_BATCH_SIZE = 128;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;

export function registerWorkspaceLifecycleTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  server.registerTool(
    "close_workspace",
    {
      title: "Close workspace",
      description:
        "Release a DevSpace workspace lease only when work in that workspace is genuinely terminal. This does not delete a managed worktree, branch, commit, or project files. A running DevSpace process session blocks release. The released workspaceId cannot be reused; open the project again if more work is needed later.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        managed: z.boolean(),
        status: z.enum(["released", "missing"]),
        terminalAt: z.string().optional(),
        terminalReason: z.string().optional(),
        worktreeRetained: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();

      // Keep the running-process check and lifecycle transition synchronous with
      // respect to the Node event loop: no await may appear between these calls.
      // processSessions.start() records the session before its first yield, so a
      // concurrent start either wins and blocks close or sees the terminal ID.
      if (processSessions.hasRunningForWorkspace(workspaceId)) {
        throw new Error(
          `Workspace ${workspaceId} still owns a running process session. Terminate or finish it before closing the workspace.`,
        );
      }

      const session = workspaces.releaseWorkspace(workspaceId);
      const worktreeRetained = session.mode === "worktree" && session.managed;
      const result = {
        workspaceId: session.id,
        root: session.root,
        mode: session.mode,
        managed: session.managed,
        status: session.status,
        terminalAt: session.terminalAt,
        terminalReason: session.terminalReason,
        worktreeRetained,
      } as const;
      const content = [
        textBlock(
          worktreeRetained
            ? `Released workspace ${session.id}. The managed worktree, branch, commits, and files were retained. Separate Git/process/lock/integration proof is still required before worktree removal.`
            : `Released workspace ${session.id}. No project files, branch, or commits were deleted.`,
        ),
      ];

      logToolCall(config, {
        tool: "close_workspace",
        workspaceId: session.id,
        path: session.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: result,
      };
    },
  );
}

export function startManagedWorkspaceReconciliation(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): () => void {
  let cursor: string | undefined;
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await workspaces.reconcileManagedWorktreeSessions({
        cursor,
        limit: RECONCILIATION_BATCH_SIZE,
      });
      cursor = result.nextCursor;
      if (result.reconciled > 0) {
        logEvent(config.logging, "info", "workspace_sessions_reconciled", {
          checked: result.checked,
          reconciled: result.reconciled,
          batchSize: RECONCILIATION_BATCH_SIZE,
        });
      }
    } catch (error) {
      logEvent(config.logging, "warn", "workspace_session_reconciliation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, RECONCILIATION_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
