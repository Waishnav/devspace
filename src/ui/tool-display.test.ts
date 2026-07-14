import assert from "node:assert/strict";
import type { ToolResultCard } from "./card-types.js";
import { toolIcons } from "./icons.js";
import { getToolDisplay, getToolHeaderSummary } from "./tool-display.js";

const displayCases: Array<[ToolResultCard, { title: string; tone: string }]> = [
  [{ tool: "open_workspace", root: "/tmp/project" }, { title: "Opened workspace", tone: "workspace" }],
  [{ tool: "read", path: "src/read.ts" }, { title: "Read file", tone: "read" }],
  [{ tool: "write", path: "src/write.ts" }, { title: "Wrote file", tone: "write" }],
  [{ tool: "edit", path: "src/edit.ts" }, { title: "Edited file", tone: "edit" }],
  [{
    tool: "apply_patch",
    files: [{ path: "src/new.ts", operation: "add" }],
  }, { title: "Added 1 file", tone: "write" }],
  [{
    tool: "grep",
    summary: { pattern: "needle", scope: "src" },
  }, { title: "Searched files", tone: "search" }],
  [{ tool: "ls", path: "src" }, { title: "Listed directory", tone: "directory" }],
  [{ tool: "bash", summary: { command: "npm test", exitCode: 0 } }, { title: "Ran command", tone: "shell" }],
];

for (const [card, expected] of displayCases) {
  assert.deepEqual(pickDisplay(getToolDisplay(card)), expected);
}

assert.equal(getToolDisplay({ tool: "open_workspace", root: "/tmp/project" }).label, "/tmp/project");
assert.equal(
  getToolDisplay({ tool: "grep", summary: { pattern: "needle", scope: "src" } }).label,
  "needle in src",
);

assert.deepEqual(
  pickDisplay(getToolDisplay({
    tool: "show_changes",
    files: [
      { path: "src/a.ts", operation: "update" },
      { path: "src/b.ts", operation: "update" },
    ],
  })),
  { title: "Edited 2 files", tone: "review" },
);

assert.deepEqual(
  pickDisplay(getToolDisplay({
    tool: "show_changes",
    files: [
      { path: "src/a.ts", operation: "add" },
      { path: "src/b.ts", operation: "update" },
    ],
  })),
  { title: "Changed 2 files", tone: "review" },
);

assert.equal(
  getToolDisplay({ tool: "exec_command", summary: { running: true, command: "npm test" } }).title,
  "Command running",
);
assert.equal(
  getToolDisplay({ tool: "exec_command", summary: { running: false, exitCode: 1 } }).title,
  "Command failed",
);
assert.equal(
  getToolDisplay({ tool: "write_stdin", summary: { running: false, exitCode: 0 } }).title,
  "Process finished",
);

assert.deepEqual(
  pickDisplay(getToolDisplay({ tool: "glob", summary: { lines: 1, pattern: "**/*.ts" } })),
  { title: "Found files", tone: "search" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "glob", summary: { lines: 1 } }),
  { kind: "empty" },
);

assert.equal(
  getToolDisplay({
    tool: "apply_patch",
    files: [{ path: "src/removed.ts", operation: "delete" }],
  }).icon,
  toolIcons.deleteFile,
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "show_changes", summary: { additions: 14, removals: 1 } }),
  { kind: "diff", additions: 14, removals: 1 },
);

assert.deepEqual(
  getToolHeaderSummary({
    tool: "open_workspace",
    summary: { mode: "worktree", agentsFiles: 1, skills: 4 },
  }),
  { kind: "text", text: "worktree · 1 instruction · 4 skills" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "exec_command", summary: { lines: 3, wallTimeMs: 1_500 } }),
  { kind: "text", text: "3 lines · 1.5s" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "grep", summary: { lines: 2 } }),
  { kind: "text", text: "2 lines" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "read", summary: { lines: 1 } }),
  { kind: "text", text: "1 line" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "ls", summary: { lines: 0 } }),
  { kind: "text", text: "0 lines" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "open_workspace" }),
  { kind: "empty" },
);

function pickDisplay(display: ReturnType<typeof getToolDisplay>) {
  return {
    title: display.title,
    tone: display.tone,
  };
}
