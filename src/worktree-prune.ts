import type { Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import {
  cleanupManagedWorktrees,
  DEFAULT_MANAGED_WORKTREE_RETENTION_MS,
  type ManagedWorktreeCleanupResult,
} from "./git-worktrees.js";
import {
  closeWorkspaceStoreResult,
  createWorkspaceStoreResult,
  type WorkspaceStoreError,
} from "./workspace-store.js";

export async function pruneStaleManagedWorktrees(
  config: ServerConfig,
  now = new Date(),
): Promise<BetterResult<ManagedWorktreeCleanupResult, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);

  if (opened.isErr()) return opened;

  let result!: BetterResult<ManagedWorktreeCleanupResult, WorkspaceStoreError>;
  let closed!: BetterResult<void, WorkspaceStoreError>;

  try {
    result = await cleanupManagedWorktrees({
      store: opened.value,
      worktreeRoot: config.worktreeRoot,
      allowedRoots: config.allowedRoots,
      staleBefore: new Date(now.getTime() - DEFAULT_MANAGED_WORKTREE_RETENTION_MS),
    });
  } finally {
    closed = closeWorkspaceStoreResult(opened.value);
  }

  if (result.isErr()) return result;

  if (closed.isErr()) return closed;

  return result;
}
