import assert from "node:assert/strict";
import test from "node:test";
import { isExpandableCard } from "./card-types.js";

test("aggregate review opens when a patch is available", () => {
  const card = {
    tool: "show_changes" as const,
    files: [{ path: "src/a.ts", type: "change" as const }],
    payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
  };
  assert.equal(isExpandableCard(card), true);
});

test("workspace details open only when there is useful context", () => {
  assert.equal(isExpandableCard({ tool: "open_workspace" }), false);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    skills: [{ name: "research" }],
  }), true);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    review: { available: false, reason: "Not a Git repository." },
  }), true);
});
