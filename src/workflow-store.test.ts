import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "./workflow-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workflow-store-"));
const store = new WorkflowStore(root);

try {
  const run = store.createRun({
    workspaceId: "ws", workspaceRoot: root, meta: { name: "store", description: "Store test" },
    scriptSource: "return null", scriptHash: "hash", argsPresent: false, defaults: {}, policy: {},
    runtimeVersion: "devspace-workflow/v1", outputTokenBudget: 10,
  });
  const step = store.createStep({ runId: run.id, kind: "agent", logicalPath: "0:1",
    requestHash: "request", request: { prompt: "test" }, workspaceId: "ws" });
  const attempt = store.createAttempt({ stepId: step.id, agentId: "agt", agentTurnId: 42, reason: "initial" });

  assert.equal(store.recordUsage({ attemptId: attempt.id, sequence: 1, outputTokens: 2, complete: false }).knownOutputTokens, 2);
  assert.equal(store.recordUsage({ attemptId: attempt.id, sequence: 1, outputTokens: 99, complete: true }).knownOutputTokens, 2,
    "duplicate provider usage sequence is ignored");
  const budget = store.recordUsage({ attemptId: attempt.id, sequence: 2, outputTokens: 5, complete: true });
  assert.equal(budget.knownOutputTokens, 5, "cumulative provider usage is charged by delta");
  assert.equal(budget.usageComplete, true);

  store.finishAttemptAndStep(attempt.id, "completed", "completed", { output: "done" });
  store.recordDelivery(step.id, 1);
  store.transitionRun(run.id, "completed", { result: "done" });
  const resumed = store.createResumedRun({
    workspaceId: "ws", workspaceRoot: root, sourceRunId: run.id,
    meta: run.meta, scriptSource: run.scriptSource, scriptHash: run.scriptHash,
    argsPresent: false, defaults: {}, policy: {}, runtimeVersion: run.runtimeVersion,
  });
  assert.equal(resumed.budgetId, run.budgetId);
  assert.equal(store.getBudget(resumed.budgetId).knownOutputTokens, 5);
  assert.throws(() => store.createResumedRun({
    workspaceId: "ws", workspaceRoot: root, sourceRunId: run.id,
    meta: run.meta, scriptSource: run.scriptSource, scriptHash: run.scriptHash,
    argsPresent: false, defaults: {}, policy: {}, runtimeVersion: run.runtimeVersion,
  }), /unique/i, "one source generation cannot be resumed concurrently twice");

  assert.equal(store.markActiveAttemptsUncertain(), 1);
  assert.equal(store.getRun(resumed.id)?.state, "recovery_required");
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
