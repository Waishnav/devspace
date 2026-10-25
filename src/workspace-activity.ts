import { git } from "./git.js";
import { readReviewRef, type ReviewChangesResult } from "./review-checkpoints.js";
import type {
  ActivityWorkspaceRecord,
  WorkspaceActivityStore,
  WorkspaceToolCall,
  WorkspaceTurn,
} from "./workspace-activity-store.js";

// Read API for workspace observability. A turn is the work between two review
// checkpoints: turn N holds the tool calls made after checkpoint N-1 and the
// diff from checkpoint N-1 to checkpoint N.

export type { WorkspaceToolCall, WorkspaceTurn } from "./workspace-activity-store.js";

export interface ActivityWorkspace extends ActivityWorkspaceRecord {
  /** Current branch of the workspace root; absent when detached or unreadable. */
  branch?: string;
}

export type TurnDiff =
  | { status: "available"; review: ReviewChangesResult }
  | { status: "open" }
  | { status: "unavailable"; reason: string };

export async function listActivityWorkspaces(
  store: WorkspaceActivityStore,
): Promise<ActivityWorkspace[]> {
  return Promise.all(store.listWorkspaces().map(withBranch));
}

export async function getActivityWorkspace(
  store: WorkspaceActivityStore,
  workspaceId: string,
): Promise<ActivityWorkspace | undefined> {
  const workspace = store.getWorkspace(workspaceId);
  return workspace ? withBranch(workspace) : undefined;
}

/** Lists a workspace's turns, latest first. */
export function listWorkspaceTurns(
  store: WorkspaceActivityStore,
  workspaceId: string,
): WorkspaceTurn[] {
  return store.listTurns(workspaceId);
}

/** Lists the tool calls of turn `sequence`, or undefined when the turn does not exist. */
export function listTurnToolCalls(
  store: WorkspaceActivityStore,
  workspaceId: string,
  sequence: number,
): WorkspaceToolCall[] | undefined {
  const turn = store.getTurn(workspaceId, sequence);
  return turn ? store.listToolCalls(turn.id) : undefined;
}

/**
 * Reads the diff of turn `sequence`: checkpoint N-1 to checkpoint N. Each
 * checkpoint snapshot is a commit whose parent is the previous checkpoint, so
 * this is exactly the diff show_changes reported when it closed the turn.
 */
export async function readTurnDiff(
  store: WorkspaceActivityStore,
  workspaceId: string,
  sequence: number,
): Promise<TurnDiff | undefined> {
  const workspace = store.getWorkspace(workspaceId);
  const turn = store.getTurn(workspaceId, sequence);
  if (!workspace || !turn) return undefined;
  if (!turn.reviewRef) return { status: "open" };

  try {
    return { status: "available", review: await readReviewRef(workspace.root, turn.reviewRef) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function withBranch(workspace: ActivityWorkspaceRecord): Promise<ActivityWorkspace> {
  try {
    const branch = (await git(workspace.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    return branch ? { ...workspace, branch } : workspace;
  } catch {
    return workspace;
  }
}
