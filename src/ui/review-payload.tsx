import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileDiffOptions } from "@pierre/diffs";
import type { HostContext, ToolResultCard } from "./card-types.js";
import { ReviewFileBody } from "./review-file-body.js";
import { FullscreenReview } from "./review-fullscreen.js";
import { buildReviewFileEntries } from "./review-model.js";
import { StatusLine } from "./review-status-line.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
  presentation?: "inline" | "fullscreen";
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
  presentation = "inline",
}: PayloadRendererOptions) {
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const entries = useMemo(() => buildReviewFileEntries(card), [card]);
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!card.payload?.patch) return <StatusLine message="Diff payload is not available." />;
  if (entries.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);
  if (presentation === "fullscreen") {
    return <FullscreenReview entries={entries} options={options} />;
  }

  const visibleEntries = typeof visibleFileCount === "number"
    ? entries.slice(0, visibleFileCount)
    : entries;

  return (
    <div className="review-diff">
      <div className="review-diff-files">
        {visibleEntries.map((entry) => {
          const key = entry.path;
          const isOpen = openFiles.has(key);

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
                <span className="review-diff-file-name">{entry.path}</span>
                <span className="review-diff-file-stats">
                  <span className="add">+{entry.additions}</span>
                  <span className="remove">-{entry.removals}</span>
                </span>
              </button>
              {isOpen ? <ReviewFileBody entry={entry} options={options} /> : null}
            </div>
          );
        })}
      </div>
    </div>
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
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
  };
}
