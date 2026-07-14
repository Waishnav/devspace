import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ToolResultCard } from "./card-types.js";

export type ReviewFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed";

export interface ReviewFileEntry {
  path: string;
  previousPath?: string;
  type?: string;
  additions: number;
  removals: number;
  status: ReviewFileStatus;
  fileDiff?: FileDiffMetadata;
}

export function buildReviewFileEntries(card: ToolResultCard): ReviewFileEntry[] {
  const parsedFiles = parseReviewPatch(card.payload?.patch);
  const parsedByPath = new Map(parsedFiles.map((fileDiff) => [fileDiff.name, fileDiff]));
  const entries: ReviewFileEntry[] = [];

  for (const file of card.files ?? []) {
    if (!file.path) continue;

    const fileDiff = parsedByPath.get(file.path);
    const stats = fileDiff ? reviewFileStats(fileDiff) : undefined;
    entries.push({
      path: file.path,
      previousPath: file.previousPath ?? fileDiff?.prevName,
      type: file.type,
      additions: file.additions ?? stats?.additions ?? 0,
      removals: file.removals ?? stats?.removals ?? 0,
      status: reviewFileStatus(file.type),
      fileDiff,
    });
    parsedByPath.delete(file.path);
  }

  for (const fileDiff of parsedFiles) {
    if (!parsedByPath.has(fileDiff.name)) continue;

    const stats = reviewFileStats(fileDiff);
    entries.push({
      path: fileDiff.name,
      previousPath: fileDiff.prevName,
      additions: stats.additions,
      removals: stats.removals,
      status: fileDiff.prevName && fileDiff.prevName !== fileDiff.name
        ? "renamed"
        : "modified",
      fileDiff,
    });
  }

  return entries;
}

export function parseReviewPatch(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

export function reviewFileStats(
  fileDiff: FileDiffMetadata,
): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

export function reviewFileStatus(type: string | undefined): ReviewFileStatus {
  if (type === "new") return "added";
  if (type === "deleted") return "deleted";
  if (type === "rename-pure" || type === "rename-changed") return "renamed";
  return "modified";
}

export function initialReviewPath(
  entries: ReviewFileEntry[],
  selectedPath?: string,
): string | undefined {
  if (selectedPath && entries.some((entry) => entry.path === selectedPath)) {
    return selectedPath;
  }
  return entries[0]?.path;
}
