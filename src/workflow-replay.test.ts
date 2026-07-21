import assert from "node:assert/strict";
import { createWorkflowReplay } from "./workflow-replay.js";
import type { WorkflowAgentCallRecord } from "./workflow-types.js";

function call(
  partial: Partial<WorkflowAgentCallRecord> &
    Pick<WorkflowAgentCallRecord, "callIndex" | "cacheKey" | "responseText">,
): WorkflowAgentCallRecord {
  return {
    runId: "wfr_prior",
    provider: "codex",
    status: "completed",
    fromCache: false,
    isolation: "shared",
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "k0", responseText: "a" }),
    call({ callIndex: 1, cacheKey: "k1", responseText: "b" }),
  ]);
  assert.equal(replay.match(0, "k0")?.value, "a");
  assert.equal(replay.match(1, "k1")?.value, "b");
  assert.equal(replay.match(2, "k0"), null);
}

{
  // fan-out reorder: callIndex mismatch, consume-once by key
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "ka", responseText: "A" }),
    call({ callIndex: 1, cacheKey: "kb", responseText: "B" }),
  ]);
  // new run asks index0 for kb first
  assert.equal(replay.match(0, "kb")?.value, "B");
  assert.equal(replay.match(1, "ka")?.value, "A");
  assert.equal(replay.match(2, "ka"), null);
}

{
  const replay = createWorkflowReplay([
    call({
      callIndex: 0,
      cacheKey: "ks",
      responseText: '{"ok":true}',
      structuredJson: '{"ok":true}',
    }),
  ]);
  assert.deepEqual(replay.match(0, "ks")?.value, { ok: true });
}

console.log("workflow-replay.test.ts: ok");
