import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";
import {
  fileChangeKindLabel,
  getRenderedFileChangePathDisplay,
  getRenderedFileChangeKind,
  type FileChangeKind,
} from "./patch-display.js";
import { pierrePrettyScrollbarCss } from "./scrollbar.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
  visibleFileCount,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseFiles(patch), [patch]);
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  if (files.length === 1) {
    return (
      <div className="review-single-file">
        <FileDiff
          fileDiff={files[0]}
          options={options}
          className="pierre-diff pretty-scrollbar"
        />
      </div>
    );
  }

  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);
          const changeKind = getRenderedFileChangeKind(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
              type: fileDiff.type,
            },
            index,
          );
          const pathDisplay = getRenderedFileChangePathDisplay(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
            },
            index,
          );

          return (
            <div className="review-diff-file" key={key}>
              <button
                type="button"
                className="review-diff-file-header"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(openFiles);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  setOpenFiles(next);
                }}
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
                  <span
                    className="review-diff-file-name renamed"
                    title={pathDisplay.title}
                  >
                    <span className="review-diff-file-path previous">
                      {pathDisplay.previous}
                    </span>
                    <span className="review-diff-file-arrow">→</span>
                    <span className="review-diff-file-path current">
                      {pathDisplay.current}
                    </span>
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
              {isOpen ? (
                <FileDiff
                  fileDiff={fileDiff}
                  options={options}
                  className="pierre-diff pretty-scrollbar"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fileChangeSymbol(kind: FileChangeKind): string {
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

function parseFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
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

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined> {
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

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
