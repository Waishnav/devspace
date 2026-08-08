import assert from "node:assert/strict";
import {
  renderWorkflowTui,
  resolveWorkflowTuiWorkspaceRoot,
} from "./workflow-tui.js";
import type { WorkflowProjectView } from "./workflow-view.js";

const project: WorkflowProjectView = {
  workspaceRoot: "/tmp/project",
  version: "1",
  runs: [
    {
      id: "wfr_1",
      name: "Review auth",
      status: "running",
      source: "named",
      scriptPath: "/tmp/review.js",
      scriptHash: "abc",
      workspaceRoot: "/tmp/project",
      currentPhase: "Implementation",
      calls: {
        running: 1,
        completed: 1,
        cached: 0,
        failed: 0,
        cancelled: 0,
        observed: 2,
      },
      phases: [
        {
          title: "Implementation",
          status: "running",
          calls: [
            {
              callIndex: 1,
              status: "running",
              provider: "codex",
              label: "Patch auth",
              prompt: "Patch auth",
              responseText: "Tests pass",
              isolation: "worktree",
              fromCache: false,
              observations: [{
                seq: 1,
                kind: "activity",
                toolName: "bash",
                toolStatus: "completed",
                message: "Running tests",
                createdAt: "2026-07-26T10:00:02.000Z",
              }],
              updatedAt: "2026-07-26T10:00:02.000Z",
            },
          ],
        },
      ],
      unphasedCalls: [],
      recentActivity: [
        {
          seq: 1,
          type: "log",
          detail: "Running tests",
          createdAt: "2026-07-26T10:00:03.000Z",
        },
      ],
      latestEventSeq: 1,
      version: "v1",
      createdAt: "2026-07-26T10:00:00.000Z",
      startedAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T10:00:03.000Z",
    },
  ],
};

const rendered = renderWorkflowTui(project, 0, 100, 30, { ansi: false });
assert.match(rendered, /DevSpace workflows · \/tmp\/project/);
assert.match(rendered, /Review auth · Implementation/);
assert.match(rendered, /Patch auth  codex · worktree/);
assert.match(rendered, /Running tests/);
assert.match(rendered, /refreshes automatically/);
const inspected = renderWorkflowTui(project, 0, 100, 30, {
  ansi: false,
  selection: { runIndex: 0, phaseIndex: 0, callIndex: 0, focus: "inspector" },
});
assert.match(inspected, /Call inspector · Patch auth/);
assert.match(inspected, /bash · completed · Running tests/);
assert.equal(resolveWorkflowTuiWorkspaceRoot("./test-project").endsWith("test-project"), true);

console.log("workflow-tui.test.ts: ok");
