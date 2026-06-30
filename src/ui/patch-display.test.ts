import assert from "node:assert/strict";
import { getPatchDisplayParts } from "./patch-display.js";

assert.deepEqual(getPatchDisplayParts({}), {
  title: "Apply Patch",
  tone: "edit",
});

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", operation: "add" }] }),
  {
    title: "Write File",
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
    title: "Write Files",
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
    title: "Write & Edit Files",
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
    title: "Write & Edit File",
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
    title: "Edit, Move & Delete Files",
    tone: "edit",
  },
);
