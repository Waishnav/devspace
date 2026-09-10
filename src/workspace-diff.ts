import { git, getGitEligibility } from "./git.js";
import {
  createWorkingTreeSnapshot,
  readReviewBetween,
  type ReviewCheckpointManager,
  type ReviewFile,
  type ReviewSummary,
} from "./review-checkpoints.js";
import type { Workspace } from "./workspaces.js";

export type WorkspaceDiffScope =
  | { kind: "review"; reviewRef: string }
  | { kind: "working-tree" }
  | { kind: "branch"; baseRef?: string }
  | { kind: "compare"; fromRef: string; toRef: string };

export interface WorkspaceDiffResult {
  scope: WorkspaceDiffScope;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

export interface WorkspaceRefList {
  currentRef?: string;
  defaultBaseRef?: string;
  refs: string[];
}

export async function readWorkspaceDiff(
  workspace: Workspace,
  reviewCheckpoints: ReviewCheckpointManager,
  scope: WorkspaceDiffScope,
): Promise<WorkspaceDiffResult> {
  if (scope.kind === "review") {
    const review = await reviewCheckpoints.reviewByRef({
      workspaceId: workspace.id,
      root: workspace.root,
      reviewRef: scope.reviewRef,
    });
    return { scope, summary: review.summary, files: review.files, patch: review.patch };
  }

  const gitRoot = await requireGitRoot(workspace.root);
  if (scope.kind === "working-tree") {
    const head = await resolveCommit(gitRoot, "HEAD");
    const snapshot = await createWorkingTreeSnapshot(gitRoot, head);
    const diff = await readReviewBetween(gitRoot, head, snapshot);
    return { scope, ...diff };
  }

  if (scope.kind === "branch") {
    const baseRef = scope.baseRef ?? workspace.worktree?.baseRef ?? await defaultBaseRef(gitRoot);
    if (!baseRef) {
      throw new Error("No default branch comparison target is available; choose a base ref.");
    }
    const [base, head] = await Promise.all([
      resolveCommit(gitRoot, baseRef),
      resolveCommit(gitRoot, "HEAD"),
    ]);
    const mergeBase = (await git(gitRoot, ["merge-base", base, head])).stdout.trim();
    const diff = await readReviewBetween(gitRoot, mergeBase, head);
    return { scope: { kind: "branch", baseRef }, ...diff };
  }

  const [from, to] = await Promise.all([
    resolveCommit(gitRoot, scope.fromRef),
    resolveCommit(gitRoot, scope.toRef),
  ]);
  const diff = await readReviewBetween(gitRoot, from, to);
  return { scope, ...diff };
}

export async function listWorkspaceRefs(workspace: Workspace): Promise<WorkspaceRefList> {
  const gitRoot = await requireGitRoot(workspace.root);
  const [refsResult, currentRef, inferredDefault] = await Promise.all([
    git(gitRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]),
    symbolicRef(gitRoot, "HEAD"),
    defaultBaseRef(gitRoot),
  ]);
  const refs = refsResult.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.endsWith("/HEAD"));
  return {
    ...(currentRef ? { currentRef } : {}),
    ...(workspace.worktree?.baseRef ?? inferredDefault
      ? { defaultBaseRef: workspace.worktree?.baseRef ?? inferredDefault }
      : {}),
    refs: [...new Set(refs)].sort((left, right) => left.localeCompare(right)),
  };
}

async function requireGitRoot(root: string): Promise<string> {
  const eligibility = await getGitEligibility(root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "Workspace is not a Git repository.");
  }
  return eligibility.gitRoot;
}

async function resolveCommit(gitRoot: string, ref: string): Promise<string> {
  return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

async function symbolicRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["symbolic-ref", "--quiet", "--short", ref])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function defaultBaseRef(gitRoot: string): Promise<string | undefined> {
  return symbolicRef(gitRoot, "refs/remotes/origin/HEAD");
}
