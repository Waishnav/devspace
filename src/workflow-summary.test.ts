import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { loadActiveWorkflowSummaries } from "./workflow-summary.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-summary-test-"));
const store = new WorkflowStore(root);

try {
  const workspaceRoot = join(root, "project");
  const run = store.createRun({
    name: "Review",
    source: "named",
    scriptPath: join(root, "run.js"),
    scriptHash: "abc",
    workspaceRoot,
  });
  store.createRun({
    name: "Other workspace",
    source: "named",
    scriptPath: join(root, "other.js"),
    scriptHash: "other",
    workspaceRoot,
    workspaceId: "workspace-2",
  });
  store.claimRun(run.id, process.pid);
  store.startAgentCall({
    runId: run.id,
    callIndex: 0,
    cacheKey: "running",
    prompt: "Review auth",
    provider: "codex",
    isolation: "shared",
  });
  store.startAgentCall({
    runId: run.id,
    callIndex: 1,
    cacheKey: "completed",
    prompt: "Review tests",
    provider: "codex",
    isolation: "shared",
  });
  store.completeAgentCall({
    runId: run.id,
    callIndex: 1,
    responseText: "done",
  });

  assert.deepEqual(loadActiveWorkflowSummaries(store, {
    workspaceId: "workspace-1",
    workspaceRoot,
  }), [
    {
      id: run.id,
      name: "Review",
      status: "running",
      calls: { running: 1, completed: 1, failed: 0 },
    },
  ]);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("workflow-summary.test.ts: ok");
