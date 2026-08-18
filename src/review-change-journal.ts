import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import {
  parseReviewFiles,
  summarizeReviewFiles,
  type ReviewChangesResult,
  type ReviewFile,
} from "./review-diff.js";

type FileState =
  | { kind: "missing" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "unavailable" };

interface WorkspaceJournalState {
  root: string;
  baselines: Map<string, FileState>;
  moves: Map<string, string>;
}

export interface ReviewMutationCapture {
  workspaceId: string;
  root: string;
  originals: Map<string, FileState>;
}

export interface ReviewMove {
  fromPath: string;
  toPath: string;
}

export interface ReviewChangeJournal {
  initializeWorkspace(input: { workspaceId: string; root: string }): void;
  prepareMutation(input: {
    workspaceId: string;
    root: string;
    paths: readonly string[];
  }): Promise<ReviewMutationCapture>;
  commitMutation(capture: ReviewMutationCapture, moves?: readonly ReviewMove[]): void;
  hasTrackedMutations(workspaceId: string): boolean;
  reviewChanges(input: { workspaceId: string; root: string }): Promise<ReviewChangesResult>;
  markReviewed(input: { workspaceId: string; root: string }): void;
}

export function createReviewChangeJournal(): ReviewChangeJournal {
  const states = new Map<string, WorkspaceJournalState>();

  const initializeWorkspace = ({ workspaceId, root }: { workspaceId: string; root: string }): void => {
    const existing = states.get(workspaceId);
    if (existing) {
      assertWorkspaceRoot(existing.root, workspaceId, root);
      return;
    }
    states.set(workspaceId, {
      root,
      baselines: new Map(),
      moves: new Map(),
    });
  };

  return {
    initializeWorkspace,

    async prepareMutation({ workspaceId, root, paths }) {
      initializeWorkspace({ workspaceId, root });
      const state = states.get(workspaceId)!;
      const originals = new Map<string, FileState>();

      for (const path of new Set(paths)) {
        const relativePath = workspaceRelativePath(root, path);
        if (state.baselines.has(relativePath) || originals.has(relativePath)) continue;
        originals.set(relativePath, await readState(path));
      }

      return { workspaceId, root, originals };
    },

    commitMutation(capture, moves = []) {
      initializeWorkspace(capture);
      const state = states.get(capture.workspaceId)!;
      for (const [path, original] of capture.originals) {
        if (!state.baselines.has(path)) state.baselines.set(path, original);
      }
      for (const move of moves) recordMove(state.moves, move.fromPath, move.toPath);
    },

    hasTrackedMutations(workspaceId) {
      return (states.get(workspaceId)?.baselines.size ?? 0) > 0;
    },

    async reviewChanges({ workspaceId, root }) {
      initializeWorkspace({ workspaceId, root });
      const state = states.get(workspaceId)!;
      const files: ReviewFile[] = [];
      const patches: string[] = [];
      const consumed = new Set<string>();

      for (const [fromPath, toPath] of state.moves) {
        const beforeSource = state.baselines.get(fromPath);
        const beforeDestination = state.baselines.get(toPath);
        if (!beforeSource || !beforeDestination) continue;

        const [afterSource, afterDestination] = await Promise.all([
          readState(resolve(root, fromPath)),
          readState(resolve(root, toPath)),
        ]);
        if (
          beforeSource.kind !== "file" ||
          beforeDestination.kind !== "missing" ||
          afterSource.kind !== "missing" ||
          afterDestination.kind !== "file"
        ) {
          continue;
        }

        const patch = filePatch(fromPath, toPath, beforeSource, afterDestination);
        const stats = patchStats(patch);
        files.push({
          path: toPath,
          previousPath: fromPath,
          type: beforeSource.bytes.equals(afterDestination.bytes) ? "rename-pure" : "rename-changed",
          ...stats,
        });
        patches.push(patch);
        consumed.add(fromPath);
        consumed.add(toPath);
      }

      for (const [path, before] of state.baselines) {
        if (consumed.has(path)) continue;
        const after = await readState(resolve(root, path));
        if (sameState(before, after)) continue;

        const patch = filePatch(path, path, before, after);
        const stats = patchStats(patch);
        files.push({
          path,
          type: fileChangeType(before, after),
          ...stats,
        });
        patches.push(patch);
      }

      files.sort((left, right) => left.path.localeCompare(right.path));
      const summary = summarizeReviewFiles(files);
      return {
        result:
          summary.files === 0
            ? "No changes since last shown changes."
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
        summary,
        files,
        patch: patches.filter(Boolean).join("\n"),
      };
    },

    markReviewed({ workspaceId, root }) {
      initializeWorkspace({ workspaceId, root });
      const state = states.get(workspaceId)!;
      state.baselines.clear();
      state.moves.clear();
    },
  };
}

async function readState(path: string): Promise<FileState> {
  try {
    return { kind: "file", bytes: await readFile(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unavailable" };
  }
}

function filePatch(oldPath: string, newPath: string, before: FileState, after: FileState): string {
  const oldText = stateText(before);
  const newText = stateText(after);
  if (oldText !== undefined && newText !== undefined) {
    const patch = createTwoFilesPatch(
      before.kind === "missing" ? "/dev/null" : oldPath,
      after.kind === "missing" ? "/dev/null" : newPath,
      oldText,
      newText,
      "",
      "",
      { context: 3, headerOptions: FILE_HEADERS_ONLY },
    );
    return withFileModeHeader(oldPath, newPath, before, after, patch);
  }

  const oldLabel = before.kind === "missing" ? "/dev/null" : `a/${oldPath}`;
  const newLabel = after.kind === "missing" ? "/dev/null" : `b/${newPath}`;
  return withFileModeHeader(oldPath, newPath, before, after, [
    `diff --git a/${oldPath} b/${newPath}`,
    `Binary files ${oldLabel} and ${newLabel} differ`,
  ].join("\n"));
}

function withFileModeHeader(
  oldPath: string,
  newPath: string,
  before: FileState,
  after: FileState,
  patch: string,
): string {
  if (before.kind === "missing" && after.kind !== "missing") {
    return `diff --git a/${newPath} b/${newPath}\nnew file mode 100644\n${patch}`;
  }
  if (before.kind !== "missing" && after.kind === "missing") {
    return `diff --git a/${oldPath} b/${oldPath}\ndeleted file mode 100644\n${patch}`;
  }
  return patch;
}

function stateText(state: FileState): string | undefined {
  if (state.kind === "missing") return "";
  if (state.kind !== "file") return undefined;
  if (state.bytes.includes(0)) return undefined;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(state.bytes);
  } catch {
    return undefined;
  }
}

function patchStats(patch: string): Pick<ReviewFile, "additions" | "removals"> {
  const parsed = parseReviewFiles(patch)[0];
  return {
    additions: parsed?.additions ?? 0,
    removals: parsed?.removals ?? 0,
  };
}

function fileChangeType(before: FileState, after: FileState): ReviewFile["type"] {
  if (before.kind === "missing" && after.kind !== "missing") return "new";
  if (before.kind !== "missing" && after.kind === "missing") return "deleted";
  return "change";
}

function sameState(left: FileState, right: FileState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") return left.bytes.equals(right.bytes);
  return true;
}

function recordMove(moves: Map<string, string>, fromPath: string, toPath: string): void {
  let origin = normalizeRelativePath(fromPath);
  const destination = normalizeRelativePath(toPath);

  for (const [candidate, currentDestination] of moves) {
    if (currentDestination !== origin) continue;
    moves.delete(candidate);
    origin = candidate;
    break;
  }

  if (origin !== destination) moves.set(origin, destination);
}

function workspaceRelativePath(root: string, path: string): string {
  const relationship = relative(root, path);
  if (
    relationship === "" ||
    isAbsolute(relationship) ||
    relationship === ".." ||
    relationship.startsWith(`..${sep}`)
  ) {
    throw new Error(`Review journal path is outside workspace root: ${path}`);
  }
  return normalizeRelativePath(relationship);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function assertWorkspaceRoot(existingRoot: string, workspaceId: string, root: string): void {
  if (existingRoot !== root) {
    throw new Error(`Review journal workspace root mismatch for ${workspaceId}.`);
  }
}
