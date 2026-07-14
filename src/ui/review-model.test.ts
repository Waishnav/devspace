import assert from "node:assert/strict";
import {
  buildReviewFileEntries,
  initialReviewPath,
  reviewFileStatus,
} from "./review-model.js";

const patch = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 80%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1 +1 @@",
  "-old value",
  "+new value",
  "diff --git a/README.md b/README.md",
  "index 3333333..4444444 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " title",
  "+details",
  "",
].join("\n");

const entries = buildReviewFileEntries({
  tool: "show_changes",
  files: [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      type: "rename-changed",
      additions: 1,
      removals: 1,
    },
  ],
  payload: { patch },
});

assert.equal(entries.length, 2);
assert.deepEqual(
  entries.map(({ path, previousPath, additions, removals, status }) => ({
    path,
    previousPath,
    additions,
    removals,
    status,
  })),
  [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      additions: 1,
      removals: 1,
      status: "renamed",
    },
    {
      path: "README.md",
      previousPath: undefined,
      additions: 1,
      removals: 0,
      status: "modified",
    },
  ],
);
assert.ok(entries.every((entry) => entry.fileDiff));

assert.equal(reviewFileStatus("new"), "added");
assert.equal(reviewFileStatus("deleted"), "deleted");
assert.equal(reviewFileStatus("rename-pure"), "renamed");
assert.equal(reviewFileStatus("change"), "modified");

assert.equal(initialReviewPath(entries), "src/new.ts");
assert.equal(initialReviewPath(entries, "README.md"), "README.md");
assert.equal(initialReviewPath(entries, "missing.ts"), "src/new.ts");
assert.equal(initialReviewPath([]), undefined);
