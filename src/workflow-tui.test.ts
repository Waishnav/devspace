import assert from "node:assert/strict";
import {
  createWorkflowTuiState,
  reduceWorkflowTuiState,
  reconcileWorkflowTuiState,
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
      totalTokens: 2_400,
      phases: [
        {
          title: "Planning",
          status: "completed",
          calls: [],
        },
        {
          title: "Implementation",
          status: "running",
          calls: [
            {
              callIndex: 1,
              status: "running",
              provider: "codex",
              label: "Patch auth",
              phase: "Implementation",
              isolation: "worktree",
              fromCache: false,
              prompt: "Patch the auth flow",
              providerSessionId: "session_1",
              usage: {
                inputTokens: 1_600,
                outputTokens: 800,
                totalTokens: 2_400,
                state: "partial",
                updatedAt: "2026-07-26T10:00:02.000Z",
              },
              updatedAt: "2026-07-26T10:00:02.000Z",
            },
          ],
        },
      ],
      unphasedCalls: [{
        callIndex: 2,
        status: "completed",
        provider: "claude",
        label: "Summarize rollout",
        isolation: "shared",
        fromCache: false,
        prompt: "Summarize the rollout",
        responseText: "Ready",
        updatedAt: "2026-07-26T10:00:03.000Z",
      }],
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

let state = createWorkflowTuiState(project);
let rendered = renderWorkflowTui(project, state, 100, 30, { ansi: false });
assert.match(rendered, /Workflows · \/tmp\/project/);
assert.match(rendered, /Review auth  Implementation/);

state = reduceWorkflowTuiState(project, state, "return");
assert.equal(state.screen, "workflow");
rendered = renderWorkflowTui(project, state, 100, 30, { ansi: false });
assert.match(rendered, /Workflow › Review auth/);
assert.match(rendered, /PHASES\s+│ AGENTS · Implementation/);
assert.match(rendered, /Patch auth  codex  2\.4k/);
assert.match(rendered, /Other  1\/1/);

state = reduceWorkflowTuiState(project, state, "tab");
state = reduceWorkflowTuiState(project, state, "return");
assert.equal(state.screen, "call");
rendered = renderWorkflowTui(project, state, 72, 30, {
  ansi: false,
  activity: [{
    runId: "wfr_1",
    callIndex: 1,
    seq: 1,
    kind: "tool",
    status: "completed",
    label: "bash",
    detail: "npm test",
    createdAt: "2026-07-26T10:00:03.000Z",
  }],
});
assert.match(rendered, /Workflow › Implementation › Patch auth/);
assert.match(rendered, /tool\s+bash · npm test/);

let unphasedState = createWorkflowTuiState(project, "wfr_1");
unphasedState = reduceWorkflowTuiState(project, unphasedState, "down");
assert.equal(unphasedState.screen === "workflow" && unphasedState.phaseIndex, 2);
unphasedState = reduceWorkflowTuiState(project, unphasedState, "tab");
unphasedState = reduceWorkflowTuiState(project, unphasedState, "return");
assert.equal(unphasedState.screen, "call");
assert.match(renderWorkflowTui(project, unphasedState, 80, 20, { ansi: false }), /Other › Summarize rollout/);

const reorderedProject = { ...project, runs: [{ ...project.runs[0]!, id: "wfr_new" }, project.runs[0]!] };
const reconciled = reconcileWorkflowTuiState(project, reorderedProject, {
  screen: "workflow",
  runIndex: 0,
  phaseIndex: 1,
  callIndex: 0,
  focus: "calls",
});
assert.equal(reconciled.runIndex, 1);

const unsafeProject = {
  ...project,
  workspaceRoot: "/tmp/project\u001b]52;c;clipboard\u0007",
  runs: [{ ...project.runs[0]!, name: "Review\u001b[2Jauth" }],
};
const safeRender = renderWorkflowTui(unsafeProject, createWorkflowTuiState(unsafeProject), 100, 20, { ansi: false });
assert.doesNotMatch(safeRender, /\u001b|\u0007/);
assert.match(safeRender, /\\x1b/);

const narrow = renderWorkflowTui(project, {
  screen: "workflow",
  runIndex: 0,
  phaseIndex: 1,
  callIndex: 0,
  focus: "phases",
}, 60, 20, { ansi: false });
assert.match(narrow, /PHASES/);
assert.doesNotMatch(narrow, /AGENTS · Implementation/);

assert.equal(resolveWorkflowTuiWorkspaceRoot(process.cwd()), process.cwd());

console.log("workflow-tui.test.ts: ok");
