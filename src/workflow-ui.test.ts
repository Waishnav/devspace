import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import {
  loadActiveWorkflowSummaries,
  loadWorkflowUiCallDetail,
  loadWorkflowUiProject,
  loadWorkflowUiRun,
} from "./workflow-ui.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-ui-test-"));
const store = new WorkflowStore(root);

try {
  const workspaceRoot = join(root, "project");
  const run = store.createRun({
    name: "UI run",
    source: "named",
    scriptPath: join(root, "run.js"),
    scriptHash: "abc",
    workspaceRoot,
  });
  store.claimRun(run.id, process.pid);
  store.appendEvent({
    runId: run.id,
    type: "phase_started",
    phase: "Review",
    data: { title: "Review" },
  });
  store.startAgentCall({
    runId: run.id,
    callIndex: 0,
    cacheKey: "key",
    prompt: "Review auth",
    schemaJson: JSON.stringify({ type: "object" }),
    provider: "codex",
    label: "Auth review",
    phase: "Review",
    isolation: "worktree",
    worktreePath: join(root, "wt"),
  });

  const summaries = loadActiveWorkflowSummaries(store, workspaceRoot);
  assert.equal(summaries[0]?.id, run.id);
  assert.equal(summaries[0]?.currentPhase, "Review");
  assert.equal(summaries[0]?.calls.running, 1);

  const project = loadWorkflowUiProject(store, workspaceRoot);
  assert.equal(project.runs[0]?.phases[0]?.title, "Review");
  assert.equal(loadWorkflowUiRun(store, run.id)?.name, "UI run");

  const detail = loadWorkflowUiCallDetail(store, run.id, 0);
  assert.equal(detail?.prompt, "Review auth");
  assert.deepEqual(detail?.schema, { type: "object" });
  assert.equal(detail?.worktreePath, join(root, "wt"));
  assert.equal(loadWorkflowUiCallDetail(store, run.id, 99), undefined);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("workflow-ui.test.ts: ok");
