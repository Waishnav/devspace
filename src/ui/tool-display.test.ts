import assert from "node:assert/strict";
import test from "node:test";
import { toolIcons } from "./icons.js";
import { getToolDisplay, getToolHeaderSummary } from "./tool-display.js";

test("workspace display distinguishes checkout reuse from a new worktree", () => {
  const reused = getToolDisplay({
    tool: "open_workspace",
    root: "/tmp/project",
    workspaceReused: true,
  });
  assert.deepEqual(
    { title: reused.title, label: reused.label, icon: reused.icon },
    {
      title: "Reused workspace",
      label: "/tmp/project",
      icon: toolIcons.folderOpen,
    },
  );

  const worktree = getToolDisplay({
    tool: "open_workspace",
    root: "/tmp/worktree",
    mode: "worktree",
  });
  assert.deepEqual(
    { title: worktree.title, label: worktree.label, icon: worktree.icon },
    {
      title: "Opened workspace",
      label: "/tmp/worktree",
      icon: toolIcons.gitBranch,
    },
  );
});

test("process display follows running, successful, and failed lifecycles", () => {
  assert.deepEqual(
    displayState({ tool: "exec_command", summary: { running: true, command: "npm test" } }),
    { title: "Command running", label: "npm test", state: "running" },
  );
  assert.deepEqual(
    displayState({ tool: "exec_command", summary: { running: false, exitCode: 0 } }),
    { title: "Ran command", label: undefined, state: "success" },
  );
  assert.deepEqual(
    displayState({ tool: "write_stdin", summary: { running: false, exitCode: 1 } }),
    { title: "Process failed", label: undefined, state: "error" },
  );
});

test("review display reports no changes and mixed file changes", () => {
  assert.equal(getToolDisplay({ tool: "show_changes" }).title, "No changes");
  assert.deepEqual(
    pickDisplay(getToolDisplay({
      tool: "show_changes",
      files: [
        { path: "src/a.ts", type: "new" },
        { path: "src/b.ts", type: "change" },
      ],
    })),
    { title: "Changed 2 files", tone: "review" },
  );
});

test("header summaries expose caller-visible counts and duration", () => {
  assert.deepEqual(
    getToolHeaderSummary({
      tool: "open_workspace",
      summary: { agentsFiles: 1, skills: 4 },
    }),
    { kind: "text", text: "1 instruction · 4 skills" },
  );
  assert.deepEqual(
    getToolHeaderSummary({
      tool: "exec_command",
      summary: { lines: 3, wallTimeMs: 1_500 },
    }),
    { kind: "text", text: "3 lines · 1.5s" },
  );
  assert.deepEqual(
    getToolHeaderSummary({
      tool: "show_changes",
      summary: { additions: 14, removals: 1 },
    }),
    { kind: "diff", additions: 14, removals: 1 },
  );
});

function displayState(card: Parameters<typeof getToolDisplay>[0]) {
  const display = getToolDisplay(card);
  return { title: display.title, label: display.label, state: display.state };
}

function pickDisplay(display: ReturnType<typeof getToolDisplay>) {
  return { title: display.title, tone: display.tone };
}
