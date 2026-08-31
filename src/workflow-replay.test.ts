import assert from "node:assert/strict";
import { createWorkflowReplay } from "./workflow-replay.js";
import type { WorkflowAgentCallRecord } from "./workflow-types.js";

function call(
  partial: Partial<WorkflowAgentCallRecord> &
    Pick<WorkflowAgentCallRecord, "callIndex" | "cacheKey">,
): WorkflowAgentCallRecord {
  return {
    runId: "wfr_prior",
    prompt: "prompt",
    provider: "codex",
    status: "completed",
    fromCache: false,
    isolation: "shared",
    createdAt: "t",
    updatedAt: "t",
    returnValueJson: JSON.stringify(`result-${partial.callIndex}`),
    ...partial,
  };
}

function identity(
  prompt = "prompt",
  profile: { name: string | null; fingerprint: string | null } = {
    name: null,
    fingerprint: null,
  },
) {
  return {
    prompt,
    profileName: profile.name,
    profileFingerprint: profile.fingerprint,
    provider: "codex" as const,
    model: null,
    effort: null,
    schema: null,
    isolation: "shared" as const,
  };
}

{
  const replay = createWorkflowReplay([
    call({
      callIndex: 0,
      cacheKey: "profile",
      profileName: "reviewer",
      profileFingerprint: "fp-1",
    }),
  ]);
  const miss = replay.decide(
    0,
    "profile-name-changed",
    identity("prompt", { name: "implementer", fingerprint: "fp-1" }),
  ).miss;
  assert.equal(miss?.reason, "identity_changed");
  assert.deepEqual(miss?.changedFields, ["profileName"]);
}

{
  const replay = createWorkflowReplay([
    call({
      callIndex: 0,
      cacheKey: "profile",
      profileName: "reviewer",
      profileFingerprint: "fp-1",
    }),
  ]);
  const miss = replay.decide(
    0,
    "profile-fingerprint-changed",
    identity("prompt", { name: "reviewer", fingerprint: "fp-2" }),
  ).miss;
  assert.equal(miss?.reason, "identity_changed");
  assert.deepEqual(miss?.changedFields, ["profileFingerprint"]);
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "k0", returnValueJson: JSON.stringify("a") }),
    call({ callIndex: 1, cacheKey: "k1", returnValueJson: JSON.stringify("b") }),
  ]);
  assert.equal(replay.decide(0, "k0", identity()).hit?.value, "a");
  assert.equal(replay.decide(1, "k1", identity()).hit?.value, "b");
  assert.equal(replay.decide(2, "k2", identity()).miss?.reason, "no_compatible_call");
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "ka", returnValueJson: JSON.stringify("A") }),
    call({ callIndex: 1, cacheKey: "kb", returnValueJson: JSON.stringify("B") }),
  ]);
  const changed = replay.decide(0, "kb", identity()).miss;
  assert.equal(changed?.reason, "identity_changed");
  assert.equal(replay.decide(1, "kb", identity()).miss?.reason, "prefix_diverged");
}

{
  const replay = createWorkflowReplay([
    call({
      callIndex: 0,
      cacheKey: "ks",
      responseText: "bounded preview",
      structuredJson: '{"ok":true}',
      returnValueJson: '{"ok":true,"text":"exact"}',
    }),
  ]);
  assert.deepEqual(replay.decide(0, "ks", identity()).hit?.value, {
    ok: true,
    text: "exact",
  });
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "old", prompt: "old prompt" }),
    call({ callIndex: 1, cacheKey: "later" }),
  ]);
  const miss = replay.decide(0, "new", identity("new prompt")).miss;
  assert.equal(miss?.reason, "identity_changed");
  assert.deepEqual(miss?.changedFields, ["prompt"]);
  assert.equal(replay.decide(1, "later", identity()).miss?.reason, "prefix_diverged");
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "worktree", isolation: "worktree" }),
    call({ callIndex: 1, cacheKey: "later" }),
  ]);
  assert.equal(
    replay.decide(0, "worktree", { ...identity(), isolation: "worktree" }).miss?.reason,
    "worktree_not_restored",
  );
  assert.equal(replay.decide(1, "later", identity()).miss?.reason, "prefix_diverged");
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "legacy", returnValueJson: undefined }),
  ]);
  assert.equal(replay.decide(0, "legacy", identity()).miss?.reason, "result_not_persisted");
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "corrupt", returnValueJson: "{" }),
  ]);
  assert.equal(replay.decide(0, "corrupt", identity()).miss?.reason, "stored_result_invalid");
}

console.log("workflow-replay.test.ts: ok");
