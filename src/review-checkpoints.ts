import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  reviewRef: string;
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

export type ReviewAvailability =
  | { available: true }
  | { available: false; reason: string };

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
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<ReviewAvailability>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
  reviewByRef(input: {
    workspaceId: string;
    root: string;
    reviewRef: string;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const initializations = new Map<string, Promise<void>>();

  return {
    async initializeWorkspace({ workspaceId, root }) {
      const existingState = states.get(workspaceId);
      assertWorkspaceRoot(existingState, workspaceId, root);
      if (existingState?.root === root && existingState.gitRoot !== undefined) {
        return reviewAvailability(existingState);
      }

      const pending = initializations.get(workspaceId);
      if (pending) {
        await pending;
        const initializedState = states.get(workspaceId);
        assertWorkspaceRoot(initializedState, workspaceId, root);
        return reviewAvailability(initializedState);
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
      return reviewAvailability(states.get(workspaceId));
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
      const current = await createWorkingTreeSnapshot(state.gitRoot, baseline);
      const review = await readReviewBetween(state.gitRoot, baseline, current);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
        state.baselineRefAvailable = true;
      }

      const fallbackNote = usedWorkspaceOpenFallback
        ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
        : "";
      return {
        reviewRef: current,
        result: `${
          review.summary.files === 0
            ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : formatChangedFiles(review.summary)
        }${fallbackNote}`,
        ...review,
      };
    },

    async reviewByRef({ workspaceId, root, reviewRef }) {
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

      const [openCommit, baselineCommit, reviewCommit] = await Promise.all([
        commitForRef(state.gitRoot, state.openRef),
        commitForRef(state.gitRoot, state.baselineRef),
        resolveReviewCommitOrUndefined(state.gitRoot, reviewRef),
      ]);
      if (
        !openCommit
        || !baselineCommit
        || !reviewCommit
        || reviewCommit === openCommit
      ) {
        throw new Error(`Unknown review reference for workspace ${workspaceId}: ${reviewRef}`);
      }

      const [isAfterOpen, isBeforeBaseline] = await Promise.all([
        isAncestor(state.gitRoot, openCommit, reviewCommit),
        isAncestor(state.gitRoot, reviewCommit, baselineCommit),
      ]);
      if (!isAfterOpen || !isBeforeBaseline) {
        throw new Error(`Unknown review reference for workspace ${workspaceId}: ${reviewRef}`);
      }

      return readReviewCommit(state.gitRoot, reviewCommit);
    },
  };
}

export async function readReviewRef(root: string, reviewRef: string): Promise<ReviewChangesResult> {
  const eligibility = await getGitEligibility(root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "show-changes requires a Git workspace.");
  }

  const commit = await resolveReviewCommit(eligibility.gitRoot, reviewRef);
  if (!await isKnownReviewCommit(eligibility.gitRoot, commit)) {
    throw new Error(`Unknown DevSpace review reference: ${reviewRef}`);
  }
  return readReviewCommit(eligibility.gitRoot, commit);
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
      const head = (await git(eligibility.gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      const initialCommit = await createWorkingTreeSnapshot(eligibility.gitRoot, head);
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

function reviewAvailability(state: WorkspaceReviewState | undefined): ReviewAvailability {
  return state?.gitRoot
    ? { available: true }
    : {
        available: false,
        reason: state?.diagnostic ?? "show_changes is unavailable for this workspace.",
      };
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

async function createWorkingTreeSnapshot(gitRoot: string, parent: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readReviewCommit(gitRoot: string, reviewRef: string): Promise<ReviewChangesResult> {
  const parent = (await git(gitRoot, ["rev-parse", "--verify", `${reviewRef}^1`])).stdout.trim();
  const review = await readReviewBetween(gitRoot, parent, reviewRef);
  return {
    reviewRef,
    result: review.summary.files === 0 ? "No changes in this review." : formatChangedFiles(review.summary),
    ...review,
  };
}

async function readReviewBetween(
  gitRoot: string,
  before: string,
  after: string,
): Promise<Pick<ReviewChangesResult, "summary" | "files" | "patch">> {
  const patch = (await git(gitRoot, ["diff", "--binary", "--no-color", before, after], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  const numstat = (await git(gitRoot, ["diff", "--numstat", "-z", before, after], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  const files = parseNumstat(numstat);
  return {
    summary: summarizeFiles(files),
    files,
    patch,
  };
}

async function resolveReviewCommit(gitRoot: string, reviewRef: string): Promise<string> {
  if (!isReviewRef(reviewRef)) {
    throw new Error(`Invalid review reference: ${reviewRef}`);
  }
  return (await git(gitRoot, ["rev-parse", "--verify", `${reviewRef}^{commit}`])).stdout.trim();
}

async function resolveReviewCommitOrUndefined(
  gitRoot: string,
  reviewRef: string,
): Promise<string | undefined> {
  try {
    return await resolveReviewCommit(gitRoot, reviewRef);
  } catch {
    return undefined;
  }
}

async function isAncestor(gitRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(gitRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function isKnownReviewCommit(gitRoot: string, reviewCommit: string): Promise<boolean> {
  const refs = (await git(gitRoot, [
    "for-each-ref",
    "--format=%(refname)\t%(objectname)",
    REVIEW_REF_PREFIX,
  ])).stdout.trim();
  if (!refs) return false;

  const histories = new Map<string, { open?: string; baseline?: string }>();
  for (const line of refs.split("\n")) {
    const [ref, commit] = line.split("\t");
    if (!ref || !commit) continue;

    const match = ref.match(/^refs\/devspace\/review\/(.+)\/(open|baseline)$/);
    if (!match) continue;
    const [, workspace, kind] = match;
    if (!workspace || !kind) continue;

    const history = histories.get(workspace) ?? {};
    history[kind as "open" | "baseline"] = commit;
    histories.set(workspace, history);
  }

  const memberships = await Promise.all(
    [...histories.values()].map(async ({ open, baseline }) => {
      if (!open || !baseline || reviewCommit === open) return false;
      const [isAfterOpen, isBeforeBaseline] = await Promise.all([
        isAncestor(gitRoot, open, reviewCommit),
        isAncestor(gitRoot, reviewCommit, baseline),
      ]);
      return isAfterOpen && isBeforeBaseline;
    }),
  );
  return memberships.some(Boolean);
}

function isReviewRef(value: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(value);
}

function formatChangedFiles(summary: ReviewSummary): string {
  return `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`;
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

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
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
