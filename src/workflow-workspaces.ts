import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { isPathInsideRoot, resolveCanonicalAllowedPath } from "./roots.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import { WorkflowError } from "./workflow-types.js";

export function isManagedWorkflowWorkspace(config: ServerConfig, root: string, id: string): boolean {
  const store = new SqliteWorkspaceStore(config.stateDir);
  try {
    const workspace = store.getSession(id);
    if (!workspace || workspace.status !== "active" || !workspace.managed || workspace.mode !== "worktree" || !workspace.sourceRoot) return false;
    const canonical = realpathSync(root);
    return canonical === realpathSync(workspace.root)
      && isPathInsideRoot(canonical, realpathSync(config.worktreeRoot))
      && config.allowedRoots.some((allowed) => {
        try { return isPathInsideRoot(realpathSync(workspace.sourceRoot!), realpathSync(allowed)); }
        catch { return false; }
      });
  } catch { return false; }
  finally { store.close(); }
}

export async function createWorkflowWorkspace(config: ServerConfig, source: LocalAgentWorkspaceScope): Promise<LocalAgentWorkspaceScope> {
  let sourcePath = source.workspaceRoot;
  let baseRef: string | undefined;
  if (source.workspaceId && isManagedWorkflowWorkspace(config, sourcePath, source.workspaceId)) {
    const store = new SqliteWorkspaceStore(config.stateDir);
    try {
      const session = store.getSession(source.workspaceId);
      if (!session?.sourceRoot || session.status !== "active") throw new WorkflowError("INVALID_WORKSPACE", "Source worktree is no longer active.");
      sourcePath = session.sourceRoot;
    }
    finally { store.close(); }
    const head = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: source.workspaceRoot, timeout: 5_000 });
    baseRef = head.stdout.trim();
  }
  await resolveCanonicalAllowedPath(sourcePath, sourcePath, config.allowedRoots);
  const worktree = await createManagedWorktree({ sourcePath, baseRef, config });
  const root = await resolveCanonicalAllowedPath(worktree.path, worktree.path, [config.worktreeRoot]);
  const store = new SqliteWorkspaceStore(config.stateDir);
  try {
    const workspace = store.createSession({
      id: `ws_${randomUUID()}`, root, mode: "worktree", sourceRoot: worktree.sourceRoot,
      baseRef: worktree.baseRef, baseSha: worktree.baseSha, managed: true,
    });
    return { workspaceRoot: root, workspaceId: workspace.id };
  } catch (error) {
    throw new WorkflowError("WORKSPACE_REGISTRATION_FAILED", `Worktree was retained at ${root}, but registering it failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { store.close(); }
}
