import { useEffect, useMemo } from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ReviewFileEntry } from "./review-model.js";

export function ReviewFileTree({
  entries,
  selectedPath,
  onSelect,
}: {
  entries: ReviewFileEntry[];
  selectedPath?: string;
  onSelect(path: string): void;
}) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const pathSet = useMemo(() => new Set(paths), [paths]);
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
      const path = selectedPaths.find((candidate) => pathSet.has(candidate));
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
