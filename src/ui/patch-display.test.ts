import assert from "node:assert/strict";
import test from "node:test";
import {
  getFileChangePathDisplay,
  getPatchDisplayParts,
  getRenderedFileChangeKind,
} from "./patch-display.js";

test("review titles describe a uniform or mixed file set", () => {
  assert.equal(getPatchDisplayParts(
    { files: [] },
    { emptyTitle: "Changes ready" },
  ).title, "Changes ready");
  assert.equal(getPatchDisplayParts({
    files: [{ path: "a.ts", type: "new" }],
  }).title, "Added 1 file");
  assert.equal(getPatchDisplayParts({
    files: [
      { path: "a.ts", type: "new" },
      { path: "b.ts", type: "change" },
    ],
  }).title, "Changed 2 files");
});

test("rename paths stay compact within one directory", () => {
  assert.deepEqual(getFileChangePathDisplay({
    path: "src/new.ts",
    previousPath: "src/old.ts",
  }), {
    current: "new.ts",
    previous: "old.ts",
    title: "src/old.ts → src/new.ts",
  });
});

test("card metadata fills gaps in parsed diff metadata", () => {
  assert.equal(getRenderedFileChangeKind(
    [{ path: "renamed.ts", type: "rename-pure" }],
    { path: "renamed.ts" },
    0,
  ), "renamed");
});
