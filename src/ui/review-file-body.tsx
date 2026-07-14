import type { FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ReviewFileEntry } from "./review-model.js";
import { StatusLine } from "./review-status-line.js";

export function ReviewFileBody({
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
