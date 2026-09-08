import assert from "node:assert/strict";
import test from "node:test";
import { isExpandableCard } from "./card-types.js";

test("review expansion requires files or a patch", () => {
  for (const [card, expected] of [
    [{ tool: "show_changes" }, false],
    [{ tool: "show_changes", files: [], payload: { patch: "" } }, false],
    [{ tool: "show_changes", payload: { patch: "diff --git a/a.ts b/a.ts" } }, true],
    [{ tool: "show_changes", files: [{ path: "a.ts", type: "change" }] }, true],
  ] satisfies Array<[Parameters<typeof isExpandableCard>[0], boolean]>) {
    assert.equal(isExpandableCard(card), expected, JSON.stringify(card));
  }
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
