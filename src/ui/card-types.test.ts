import assert from "node:assert/strict";
import test from "node:test";
import {
  isEditTool,
  isExpandableCard,
  isInitiallyExpandedCard,
  isPatchTool,
  isShellTool,
  isToolName,
} from "./card-types.js";

test("the supported coding tools are recognized as card tools", () => {
  for (const tool of ["apply_patch", "exec_command", "write_stdin"]) {
    assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
  }
});

test("tool classification distinguishes patch, edit, and shell operations", () => {
  assert.equal(isPatchTool("apply_patch"), true);
  assert.equal(isEditTool("apply_patch"), false);
  assert.equal(isShellTool("apply_patch"), false);
  assert.equal(isShellTool("exec_command"), true);
  assert.equal(isShellTool("write_stdin"), true);
  assert.equal(isEditTool("exec_command"), false);
});

test("a patch card expands only when it contains patch content", () => {
  assert.equal(
    isExpandableCard({ tool: "apply_patch", payload: { patch: "diff --git a/a b/a" } }),
    true,
  );
  assert.equal(isExpandableCard({ tool: "apply_patch" }), false);
});

test("a single-file patch opens immediately", () => {
  assert.equal(
    isInitiallyExpandedCard({
      tool: "apply_patch",
      files: [{ path: "src/a.ts", operation: "update" }],
      payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
    }),
    true,
  );
});

test("a multi-file patch stays collapsed", () => {
  assert.equal(
    isInitiallyExpandedCard({
      tool: "apply_patch",
      files: [
        { path: "src/a.ts", operation: "update" },
        { path: "src/b.ts", operation: "add" },
      ],
      payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
    }),
    false,
  );
});

test("show changes still opens immediately", () => {
  assert.equal(
    isInitiallyExpandedCard({
      tool: "show_changes",
      files: [{ path: "src/a.ts", type: "change" }],
      payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
    }),
    true,
  );
});

test("a workspace card expands when it contains provider metadata", () => {
  assert.equal(
    isExpandableCard({
      tool: "open_workspace",
      agentProviders: [{ id: "codex" }],
    }),
    true,
  );
});

test("a workspace card with details opens immediately", () => {
  assert.equal(
    isInitiallyExpandedCard({
      tool: "open_workspace",
      skills: [{ name: "research" }],
    }),
    true,
  );
});

test("a workspace card expands when it contains agent metadata", () => {
  assert.equal(
    isExpandableCard({
      tool: "open_workspace",
      agents: [{ name: "reviewer", provider: "codex" }],
    }),
    true,
  );
});

test("a workspace card expands when it contains available instruction files", () => {
  assert.equal(
    isExpandableCard({
      tool: "open_workspace",
      availableAgentsFiles: [{ path: "nested/AGENTS.md" }],
    }),
    true,
  );
});

test("an empty workspace card stays collapsed", () => {
  assert.equal(isExpandableCard({ tool: "open_workspace" }), false);
});
