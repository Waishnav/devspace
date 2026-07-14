import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { HostContext, ToolResultCard } from "./card-types.js";
import {
  buildReviewFileEntries,
  initialReviewPath,
  type ReviewFileEntry,
} from "./review-model.js";

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

function FullscreenReview({
  entries,
  options,
}: {
  entries: ReviewFileEntry[];
  options: FileDiffOptions<undefined>;
}) {
  const [selectedPath, setSelectedPath] = useState(() => initialReviewPath(entries));

  useEffect(() => {
    setSelectedPath((currentPath) => initialReviewPath(entries, currentPath));
  }, [entries]);

  const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? entries[0];

  return (
    <div className="review-workspace">
      <section className="review-selected-file">
        <header className="review-selected-file-header">
          <div className="review-selected-file-title">
            <strong title={selectedEntry?.path}>{selectedEntry?.path}</strong>
            {selectedEntry?.previousPath && selectedEntry.previousPath !== selectedEntry.path ? (
              <span title={selectedEntry.previousPath}>from {selectedEntry.previousPath}</span>
            ) : null}
          </div>
          {selectedEntry ? (
            <span className="review-diff-file-stats" aria-label="Selected file diff statistics">
              <span className="add">+{selectedEntry.additions}</span>
              <span className="remove">-{selectedEntry.removals}</span>
            </span>
          ) : null}
        </header>
        <div className="review-selected-file-body">
          {selectedEntry ? (
            <ReviewFileBody entry={selectedEntry} options={options} />
          ) : (
            <StatusLine message="Select a changed file to review it." />
          )}
        </div>
      </section>

      <aside className="review-file-tree-panel" aria-label="Changed files">
        <div className="review-file-tree-header">
          <strong>Changed files</strong>
          <span>{entries.length}</span>
        </div>
        <div className="review-file-tree-body">
          <ReviewFileTree
            entries={entries}
            selectedPath={selectedEntry?.path}
            onSelect={setSelectedPath}
          />
        </div>
      </aside>
    </div>
  );
}

function ReviewFileTree({
  entries,
  selectedPath,
  onSelect,
}: {
  entries: ReviewFileEntry[];
  selectedPath?: string;
  onSelect(path: string): void;
}) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => entries.map((entry) => ({ path: entry.path, status: entry.status })),
    [entries],
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    search: paths.length > 8,
    onSelectionChange(selectedPaths) {
      const path = selectedPaths.find((candidate) => paths.includes(candidate));
      if (path) onSelect(path);
    },
  });

  useEffect(() => {
    if (!selectedPath) return;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath, { focus: false });
  }, [model, selectedPath]);

  return <FileTree model={model} className="review-file-tree" />;
}

function ReviewFileBody({
  entry,
  options,
}: {
  entry: ReviewFileEntry;
  options: FileDiffOptions<undefined>;
}) {
  if (!entry.fileDiff) {
    return (
      <StatusLine message="This file changed without a textual diff that can be rendered." />
    );
  }

  return <FileDiff fileDiff={entry.fileDiff} options={options} className="pierre-diff" />;
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

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
