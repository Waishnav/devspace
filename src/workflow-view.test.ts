import assert from "node:assert/strict";
import { buildWorkflowRunView } from "./workflow-view.js";
import type {
  WorkflowAgentCallRecord,
  WorkflowEventRecord,
  WorkflowRunRecord,
} from "./workflow-types.js";

const run: WorkflowRunRecord = {
  id: "wfr_view",
  name: "Review auth",
  source: "named",
  scriptPath: "/tmp/review-auth.js",
  scriptHash: "abc",
  workspaceRoot: "/tmp/project",
  argsJson: "null",
  status: "running",
  cancelRequested: false,
  createdAt: "2026-07-26T10:00:00.000Z",
  startedAt: "2026-07-26T10:00:01.000Z",
  updatedAt: "2026-07-26T10:00:05.000Z",
};

const calls: WorkflowAgentCallRecord[] = [
  {
    runId: run.id,
    callIndex: 0,
    cacheKey: "a",
    prompt: "Inspect auth",
    provider: "codex",
    label: "Inspect auth",
    phase: "Planning",
    status: "completed",
    fromCache: false,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    isolation: "shared",
    createdAt: "2026-07-26T10:00:02.000Z",
    startedAt: "2026-07-26T10:00:02.000Z",
    completedAt: "2026-07-26T10:00:03.000Z",
    updatedAt: "2026-07-26T10:00:03.000Z",
  },
  {
    runId: run.id,
    callIndex: 1,
    cacheKey: "b",
    prompt: "Patch auth",
    provider: "claude",
    label: "Patch auth",
    phase: "Implementation",
    status: "running",
    fromCache: false,
    isolation: "worktree",
    worktreePath: "/tmp/worktree",
    createdAt: "2026-07-26T10:00:04.000Z",
    startedAt: "2026-07-26T10:00:04.000Z",
    updatedAt: "2026-07-26T10:00:04.000Z",
  },
  {
    runId: run.id,
    callIndex: 2,
    cacheKey: "c",
    prompt: "Cached review",
    provider: "claude",
    status: "from_cache",
    fromCache: true,
    replayMatch: "same_index",
    replayedFromRunId: "wfr_old",
    replayedFromCallIndex: 2,
    isolation: "shared",
    createdAt: "2026-07-26T10:00:04.000Z",
    completedAt: "2026-07-26T10:00:04.000Z",
    updatedAt: "2026-07-26T10:00:04.000Z",
  },
];

const events: WorkflowEventRecord[] = [
  {
    runId: run.id,
    seq: 1,
    type: "phase_started",
    phase: "Planning",
    dataJson: JSON.stringify({ title: "Planning" }),
    createdAt: "2026-07-26T10:00:01.000Z",
  },
  {
    runId: run.id,
    seq: 2,
    type: "phase_started",
    phase: "Implementation",
    dataJson: JSON.stringify({ title: "Implementation" }),
    createdAt: "2026-07-26T10:00:04.000Z",
  },
  {
    runId: run.id,
    seq: 3,
    type: "log",
    phase: "Implementation",
    dataJson: JSON.stringify({ message: "Running tests" }),
    createdAt: "2026-07-26T10:00:05.000Z",
  },
];

const observations = new Map([
  [
    1,
    [
      {
        runId: run.id,
        callIndex: 1,
        seq: 1,
        provider: "claude" as const,
        kind: "activity" as const,
        activityId: "tool-1",
        toolName: "bash",
        toolStatus: "started" as const,
        message: "Running tests",
        createdAt: "2026-07-26T10:00:04.500Z",
      },
    ],
  ],
]);

const view = buildWorkflowRunView(run, calls, events, observations);
assert.equal(view.currentPhase, "Implementation");
assert.equal(view.calls.completed, 1);
assert.equal(view.calls.running, 1);
assert.equal(view.calls.cached, 1);
assert.equal(view.calls.observed, 3);
assert.deepEqual(view.phases.map((phase) => phase.title), ["Planning", "Implementation"]);
assert.equal(view.phases[1]?.calls[0]?.worktreePath, "/tmp/worktree");
assert.equal(view.unphasedCalls[0]?.replayedFromRunId, "wfr_old");
assert.equal(view.phases[1]?.calls[0]?.observations[0]?.toolName, "bash");
assert.deepEqual(view.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
assert.equal(view.recentActivity.at(-1)?.detail, "Running tests");
assert.equal(view.latestEventSeq, 3);

console.log("workflow-view.test.ts: ok");
