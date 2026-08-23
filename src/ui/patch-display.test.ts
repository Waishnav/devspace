import assert from "node:assert/strict";
import test from "node:test";
import {
  getFileChangePathDisplay,
  getPatchDisplayParts,
  getRenderedFileChangeKind,
  getRenderedFileChangePathDisplay,
} from "./patch-display.js";

test("a homogeneous patch reports its operation and unique file count", () => {
  assert.deepEqual(
    getPatchDisplayParts({
      files: [
        { path: "created.ts", operation: "add" },
        { path: "nested.ts", operation: "add" },
      ],
    }),
    { title: "Added 2 files", iconKind: "added", tone: "write" },
  );

  assert.deepEqual(
    getPatchDisplayParts({
      files: [
        { path: "same.ts", operation: "add" },
        { path: "same.ts", operation: "update" },
      ],
    }),
    { title: "Changed 1 file", tone: "edit" },
  );
});

test("renames keep enough path context to distinguish their source", () => {
  assert.deepEqual(
    getFileChangePathDisplay({
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
    }),
    {
      current: "new-name.ts",
      previous: "old-name.ts",
      title: "src/old-name.ts → src/new-name.ts",
    },
  );

  assert.deepEqual(
    getFileChangePathDisplay({
      path: "packages/new/file.ts",
      previousPath: "src/old/file.ts",
    }),
    {
      current: "packages/new/file.ts",
      previous: "src/old/file.ts",
      title: "src/old/file.ts → packages/new/file.ts",
    },
  );
});

test("repeated destination paths use the matching patch entry", () => {
  const files = [
    { path: "shared.ts", previousPath: "first.ts", operation: "move" as const },
    { path: "shared.ts", previousPath: "second.ts", operation: "move" as const },
  ];

  assert.deepEqual(
    getRenderedFileChangePathDisplay(files, { path: "shared.ts" }, 1),
    {
      current: "shared.ts",
      previous: "second.ts",
      title: "second.ts → shared.ts",
    },
  );
});

test("parsed diff metadata wins except when apply_patch records a move", () => {
  assert.equal(
    getRenderedFileChangeKind(
      [
        { path: "same.tmp", operation: "add" },
        { path: "same.tmp", operation: "delete" },
      ],
      { path: "same.tmp", type: "deleted" },
      1,
    ),
    "deleted",
  );

  assert.equal(
    getRenderedFileChangeKind(
      [{ path: "renamed.md", previousPath: "old.md", operation: "move" }],
      { path: "renamed.md", type: "change" },
      0,
    ),
    "renamed",
  );

  assert.equal(
    getRenderedFileChangeKind(
      [{ path: "report.md", operation: "add" }],
      { path: "report.md", type: "change" },
      0,
    ),
    "edited",
  );
});
