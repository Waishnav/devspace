import assert from "node:assert/strict";
import { getPatchDisplayParts } from "./patch-display.js";

assert.deepEqual(getPatchDisplayParts({}), {
  title: "Applied patch",
  tone: "edit",
});

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", operation: "add" }] }),
  {
    title: "Added 1 file",
    iconOperation: "add",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "a.ts", operation: "add" },
      { path: "b.ts", operation: "add" },
    ],
  }),
  {
    title: "Added 2 files",
    iconOperation: "add",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "created.ts", operation: "add" },
      { path: "edited.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 2 files",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "same.ts", operation: "add" },
      { path: "same.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 1 file",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "edited.ts", operation: "update" },
      { path: "moved.ts", previousPath: "old.ts", operation: "move" },
      { path: "removed.ts", operation: "delete" },
    ],
  }),
  {
    title: "Changed 3 files",
    tone: "edit",
  },
);
