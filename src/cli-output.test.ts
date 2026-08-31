import assert from "node:assert/strict";
import {
  workflowCallOutput,
  workflowRunOutput,
} from "./cli-output.js";
import type { WorkflowAgentCallRecord, WorkflowRunRecord } from "./workflow-types.js";

const now = "2026-08-08T00:00:00.000Z";
const run: WorkflowRunRecord = {
  id: "wfr_123",
  name: "review",
  source: "inline",
  scriptPath: "/project/review.js",
  scriptHash: "internal-hash",
  workspaceRoot: "/private/project",
  workspaceId: "ws_private",
  argsJson: "null",
  status: "completed",
  resultJson: JSON.stringify({ ok: true }),
  cancelRequested: false,
  createdAt: now,
  updatedAt: now,
};
const call: WorkflowAgentCallRecord = {
  runId: run.id,
  callIndex: 0,
  cacheKey: "internal-cache-key",
  prompt: "Review",
  provider: "codex",
  profileFingerprint: "internal-fingerprint",
  status: "completed",
  fromCache: false,
  providerSessionId: "provider-secret",
  structuredJson: JSON.stringify({ bugs: [] }),
  isolation: "shared",
  createdAt: now,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const runJson = workflowRunOutput(run, [call]);
assert.deepEqual(runJson.result, { ok: true });
assert.deepEqual(runJson.calls, {
  running: 0,
  completed: 1,
  failed: 0,
  cancelled: 0,
  total: 1,
});
assert.equal("scriptHash" in runJson, false);

const callJson = workflowCallOutput(call, { detailed: true });
assert.deepEqual(callJson.structured, { bugs: [] });
assert.equal("cacheKey" in callJson, false);
assert.equal("providerSessionId" in callJson, false);
assert.equal("profileFingerprint" in callJson, false);

console.log("cli-output.test.ts: ok");
