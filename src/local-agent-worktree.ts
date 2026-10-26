import { existsSync } from "node:fs";
import { Result, type Result as BetterResult } from "better-result";
import { getGitEligibility } from "./git.js";
import { createManagedWorktree, GitWorktreeError } from "./git-worktrees.js";
import { AgentScopeError } from "./local-agent-errors.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

export interface AgentWorktree {
  path: string;
  branch: string;
}

/**
 * Creates the isolated checkout for `devspace agents run --worktree`: a new branch at the source
 * checkout's HEAD, under the configured worktree root. Uncommitted source changes are not copied.
 * The worktree is deliberately not a registered workspace session, so no stale-worktree pruning
 * removes it; the user reviews, merges, and removes it.
 */
export async function createAgentWorktree(input: {
  agentId: string;
  workspaceRoot: string;
  worktreeRoot: string;
  branch?: string;
}): Promise<BetterResult<AgentWorktree, AgentScopeError>> {
  const failure = (code: "WORKTREE_NOT_GIT_REPOSITORY" | "WORKTREE_CREATE_FAILED", message: string, cause?: unknown) =>
    Result.err(new AgentScopeError({ code, agentId: input.agentId, operation: "start", retryable: false, cause, message }));

  const eligibility = await getGitEligibility(input.workspaceRoot).catch(() => undefined);
  if (!eligibility?.ok) {
    return failure(
      "WORKTREE_NOT_GIT_REPOSITORY",
      `--worktree needs a git repository, but ${input.workspaceRoot} is not inside one. Run from a git checkout, or drop --worktree.`,
    );
  }
  if (!eligibility.hasHead) {
    return failure("WORKTREE_CREATE_FAILED", "--worktree needs at least one commit to branch from. Create an initial commit first.");
  }

  // Ref names cannot contain ':', which agent ids may.
  const branch = input.branch ?? `devspace/${input.agentId.replaceAll(":", "-")}`;
  try {
    // The checkout is already authorized by the manager; it is the only root the worktree may come from.
    const worktree = await createManagedWorktree({
      sourcePath: input.workspaceRoot,
      branch,
      config: { allowedRoots: [input.workspaceRoot], worktreeRoot: input.worktreeRoot },
    });
    return Result.ok({ path: worktree.path, branch });
  } catch (cause) {
    const message = cause instanceof GitWorktreeError || cause instanceof Error ? cause.message : String(cause);
    return failure("WORKTREE_CREATE_FAILED", `Could not create a worktree on branch ${branch}. ${message}`, cause);
  }
}

/** A worktree is the user's to remove; a later turn on a removed one fails clearly instead of running elsewhere. */
export function missingWorktreeError(record: LocalAgentRecord, operation: string): AgentScopeError | undefined {
  if (!record.worktreePath || existsSync(record.worktreePath)) return undefined;
  return new AgentScopeError({
    code: "WORKTREE_MISSING",
    agentId: record.id,
    operation,
    retryable: false,
    message: `Worktree ${record.worktreePath} for agent ${record.id} no longer exists. Branch ${record.branch} is kept: recreate the worktree with "git worktree add ${record.worktreePath} ${record.branch}" to continue, or start a new agent.`,
  });
}
