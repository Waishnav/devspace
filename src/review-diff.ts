import { parsePatchFiles } from "@pierre/diffs";

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

export function parseReviewFiles(patch: string): ReviewFile[] {
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

export function summarizeReviewFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
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
