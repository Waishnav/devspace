import assert from "node:assert/strict";
import test from "node:test";
import {
  getFileChangePathDisplay,
  getRenderedFileChangeKind,
} from "./patch-display.js";

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
