import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "workspace_open";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  openRef: string;
  baselineRef: string;
  openRefAvailable: boolean;
  baselineRefAvailable: boolean;
  diagnostic?: string;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";
const REVIEW_DIFF_MAX_BUFFER = 10_000_000;

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const initializations = new Map<string, Promise<void>>();

  return {
    async initializeWorkspace({ workspaceId, root }) {
      const existingState = states.get(workspaceId);
      assertWorkspaceRoot(existingState, workspaceId, root);
      if (existingState?.root === root && existingState.gitRoot !== undefined) {
        return;
      }

      const pending = initializations.get(workspaceId);
      if (pending) {
        await pending;
        assertWorkspaceRoot(states.get(workspaceId), workspaceId, root);
        return;
      }

      const initialize = initializeWorkspaceState(states, workspaceId, root);
      initializations.set(workspaceId, initialize);
      try {
        await initialize;
      } finally {
        if (initializations.get(workspaceId) === initialize) {
          initializations.delete(workspaceId);
        }
      }
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
      let state = states.get(workspaceId);
      assertWorkspaceRoot(state, workspaceId, root);
      if (!isReadyState(state)) {
        await this.initializeWorkspace({ workspaceId, root });
        state = states.get(workspaceId);
      }
      assertWorkspaceRoot(state, workspaceId, root);

      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }

      let effectiveSince = since;
      let usedWorkspaceOpenFallback = false;
      if (since === "last_shown" && !state.baselineRefAvailable) {
        if (!state.openRefAvailable) {
          throw new Error("Review checkpoints are missing; show_changes cannot reconstruct that history safely.");
        }
        effectiveSince = "workspace_open";
        usedWorkspaceOpenFallback = true;
      } else if (since === "workspace_open" && !state.openRefAvailable) {
        throw new Error(
          "The workspace-open review checkpoint is missing; show_changes cannot reconstruct that history safely.",
        );
      }

      const baselineRef = effectiveSince === "workspace_open" ? state.openRef : state.baselineRef;
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
      const current = await createWorkingTreeSnapshot(state.gitRoot, state.root);
      const patch = (await git(state.root, [
        "diff",
        "--relative",
        "--patch",
        "--find-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        baseline,
        current,
      ], {
        maxBuffer: REVIEW_DIFF_MAX_BUFFER,
      })).stdout;
      const files = parseReviewFiles(patch);
      const summary = summarizeFiles(files);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
        state.baselineRefAvailable = true;
      }

      const fallbackNote = usedWorkspaceOpenFallback
        ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
        : "";
      return {
        result: `${
          summary.files === 0
            ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`
        }${fallbackNote}`,
        summary,
        files,
        patch,
      };
    },
  };
}

function parseReviewFiles(patch: string): ReviewFile[] {
  if (patch.length === 0) return [];

  try {
    return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) =>
      parsedPatch.files.map((file) => {
        const stats = file.hunks.reduce(
          (total, hunk) => ({
            additions: total.additions + hunk.additionLines,
            removals: total.removals + hunk.deletionLines,
          }),
          { additions: 0, removals: 0 },
        );

        return {
          path: file.name,
          previousPath: file.prevName,
          type: reviewFileType(file.type),
          ...stats,
        };
      }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Review diff could not be rendered: ${detail}`);
  }
}

function reviewFileType(type: string): ReviewFile["type"] {
  switch (type) {
    case "rename-pure":
    case "rename-changed":
    case "new":
    case "deleted":
    case "change":
      return type;
    default:
      return "change";
  }
}

function assertWorkspaceRoot(
  state: WorkspaceReviewState | undefined,
  workspaceId: string,
  root: string,
): void {
  if (state && state.root !== root) {
    throw new Error(`Review checkpoint workspace root mismatch for ${workspaceId}.`);
  }
}

async function initializeWorkspaceState(
  states: Map<string, WorkspaceReviewState>,
  workspaceId: string,
  root: string,
): Promise<void> {
  const refs = reviewRefs(workspaceId);
  const state: WorkspaceReviewState = {
    root,
    ...refs,
    openRefAvailable: false,
    baselineRefAvailable: false,
  };

  try {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) {
      state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
      return;
    }

    const [openCommit, baselineCommit] = await Promise.all([
      commitForRef(eligibility.gitRoot, state.openRef),
      commitForRef(eligibility.gitRoot, state.baselineRef),
    ]);

    if (!openCommit && !baselineCommit) {
      const initialCommit = await createWorkingTreeSnapshot(eligibility.gitRoot, root);
      await git(eligibility.gitRoot, ["update-ref", state.openRef, initialCommit]);
      await git(eligibility.gitRoot, ["update-ref", state.baselineRef, initialCommit]);
      state.openRefAvailable = true;
      state.baselineRefAvailable = true;
    } else {
      state.openRefAvailable = openCommit !== undefined;
      state.baselineRefAvailable = baselineCommit !== undefined;
    }

    state.gitRoot = eligibility.gitRoot;
  } catch (error) {
    state.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    states.set(workspaceId, state);
  }
}

function isReadyState(state: WorkspaceReviewState | undefined): boolean {
  return state?.gitRoot !== undefined;
}

async function commitForRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function reviewRefs(
  workspaceId: string,
): Pick<WorkspaceReviewState, "openRef" | "baselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function createWorkingTreeSnapshot(gitRoot: string, workspaceRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    if (await commitForRef(gitRoot, "HEAD")) {
      await git(gitRoot, ["read-tree", "HEAD"], { env });
    }
    await git(workspaceRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    return (await git(gitRoot, ["commit-tree", tree, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
