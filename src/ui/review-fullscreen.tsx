import { useEffect, useState } from "react";
import type { FileDiffOptions } from "@pierre/diffs";
import { ReviewFileBody } from "./review-file-body.js";
import { ReviewFileTree } from "./review-file-tree.js";
import {
  initialReviewPath,
  type ReviewFileEntry,
} from "./review-model.js";
import { StatusLine } from "./review-status-line.js";

export function FullscreenReview({
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
