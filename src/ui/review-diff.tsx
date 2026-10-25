import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ToolResultCard } from "./card-types.js";
import {
  fileChangeKindLabel,
  getRenderedFileChangePathDisplay,
  getRenderedFileChangeKind,
  type FileChangeKind,
} from "./patch-display.js";
import { pierrePrettyScrollbarCss } from "./scrollbar.js";

// Diff rendering shared by the show_changes card and the workspace web pages.
// Styles live in review-diff.css.

export type ReviewThemeType = "light" | "dark";
export type ReviewFileMetadata = NonNullable<ToolResultCard["files"]>;

export function parseReviewFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

export function reviewFileKey(fileDiff: FileDiffMetadata, index: number): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
}

export function ReviewFileDiff({ fileDiff, themeType }: {
  fileDiff: FileDiffMetadata;
  themeType: ReviewThemeType;
}) {
  return (
    <FileDiff
      fileDiff={fileDiff}
      options={diffOptions(themeType)}
      className="pierre-diff pretty-scrollbar"
    />
  );
}

/** One collapsible file: a header with change kind, path, and stats, then its diff. */
export function ReviewDiffFile({
  fileDiff,
  index,
  files,
  themeType,
  open,
  onToggle,
  id,
}: {
  fileDiff: FileDiffMetadata;
  index: number;
  files: ReviewFileMetadata;
  themeType: ReviewThemeType;
  open: boolean;
  onToggle(): void;
  id?: string;
}) {
  const stats = diffStats(fileDiff);
  const changeKind = getRenderedFileChangeKind(
    files,
    { path: fileDiff.name, previousPath: fileDiff.prevName, type: fileDiff.type },
    index,
  );
  const pathDisplay = getRenderedFileChangePathDisplay(
    files,
    { path: fileDiff.name, previousPath: fileDiff.prevName },
    index,
  );

  return (
    <div className="review-diff-file" id={id}>
      <button
        type="button"
        className="review-diff-file-header"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span
          className={`review-file-kind ${changeKind}`}
          role="img"
          title={fileChangeKindLabel(changeKind)}
          aria-label={fileChangeKindLabel(changeKind)}
        >
          {fileChangeSymbol(changeKind)}
        </span>
        {pathDisplay?.previous ? (
          <span className="review-diff-file-name renamed" title={pathDisplay.title}>
            <span className="review-diff-file-path previous">{pathDisplay.previous}</span>
            <span className="review-diff-file-arrow">→</span>
            <span className="review-diff-file-path current">{pathDisplay.current}</span>
          </span>
        ) : (
          <span className="review-diff-file-name" title={pathDisplay?.title ?? fileDiff.name}>
            {pathDisplay?.current ?? fileDiff.name}
          </span>
        )}
        <span className="review-diff-file-stats">
          <span className="add">+{stats.additions}</span>
          <span className="remove">-{stats.removals}</span>
        </span>
      </button>
      {open ? <ReviewFileDiff fileDiff={fileDiff} themeType={themeType} /> : null}
    </div>
  );
}

export function fileChangeSymbol(kind: FileChangeKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "edited":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
    case "renamed-edited":
      return "R";
    case "unknown":
      return "•";
  }
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

function diffOptions(themeType: ReviewThemeType): FileDiffOptions<undefined> {
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    unsafeCSS: pierrePrettyScrollbarCss,
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
  };
}
