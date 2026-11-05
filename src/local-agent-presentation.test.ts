import assert from "node:assert/strict";
import test from "node:test";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import {
  agentObservationExitCode,
  formatAgentObservation,
  formatAgentTargetCatalog,
  formatAgentTurnEvent,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

const record: LocalAgentRecord = {
  id: "agt_test",
  workspaceId: "ws_private",
  workspaceRoot: "/private/project",
  profileName: "reviewer",
  providerInstanceId: "codex",
  driver: "codex",
  model: "gpt-5.4",
  effort: "high",
  writeMode: "allowed",
  providerSessionId: "provider_private",
  status: "running",
  latestResponse: "previous response",
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:01:00.000Z",
};

test("receipts and summaries report public agent statuses", () => {
  assert.deepEqual(presentAgentReceipt({ ...record, status: "starting" }), {
    id: "agt_test",
    status: "running",
  });
  assert.deepEqual(presentAgentSummary({ ...record, status: "idle" }), {
    id: "agt_test",
    status: "completed",
    target: "reviewer",
  });
});

// Worktree agents report where their branch lives, in every output shape.
test("worktree agents report where their branch lives in every output shape", () => {
  const worktreeRecord = { ...record, status: "idle" as const, worktreePath: "/wt/app-1a2b", branch: "devspace/agt_test" };
  assert.deepEqual(presentAgentReceipt(worktreeRecord), {
    id: "agt_test",
    status: "completed",
    worktree: "/wt/app-1a2b",
    branch: "devspace/agt_test",
  });
  assert.equal(
    formatAgentObservation(presentAgentObservation(worktreeRecord)),
    '<agent id="agt_test" status="completed" worktree="/wt/app-1a2b" branch="devspace/agt_test">previous response</agent>',
  );
  assert.equal(
    formatAgentObservation(presentAgentObservation({ ...worktreeRecord, status: "running" })),
    '<agent id="agt_test" status="running" worktree="/wt/app-1a2b" branch="devspace/agt_test"/>',
  );
  assert.equal(presentAgentSummary(worktreeRecord).branch, "devspace/agt_test");
});

test("observations carry the response or a structured error", () => {
  const completed = presentAgentObservation({
    ...record,
    status: "idle",
    latestResponse: "Found one issue.",
  });

  assert.deepEqual(completed, {
    id: "agt_test",
    status: "completed",
    response: "Found one issue.",
  });

  const failed = presentAgentObservation({
    ...record,
    status: "error",
    latestResponse: undefined,
    error: "Provider disconnected.",
    errorCode: "PROVIDER_EXECUTION_ERROR",
    errorRetryable: true,
  });

  assert.deepEqual(failed, {
    id: "agt_test",
    status: "failed",
    error: {
      code: "PROVIDER_EXECUTION_ERROR",
      message: "Provider disconnected.",
      retryable: true,
    },
  });
});

// The turn id and the provider's own error cause are visible in fragments.
test("the turn id and the provider's own error cause are visible in fragments", () => {
  const failedWithCause = presentAgentObservation({
    ...record,
    status: "error",
    latestTurnId: "trn_12345678",
    error: "Claude agent turn failed.",
    errorCode: "PROVIDER_EXECUTION_ERROR",
    errorRetryable: false,
    errorDetail: "Claude returned an error result: rate <limited>",
  });

  assert.equal(
    formatAgentObservation(failedWithCause),
    '<agent id="agt_test" status="failed" turn="trn_12345678" code="PROVIDER_EXECUTION_ERROR" retryable="false">Claude agent turn failed.<cause>Claude returned an error result: rate &lt;limited&gt;</cause></agent>',
  );
  assert.equal(
    formatAgentObservation(presentAgentObservation({ ...record, latestTurnId: "trn_12345678" })),
    '<agent id="agt_test" status="running" turn="trn_12345678"/>',
  );
});

test("turn events format as event fragments", () => {
  assert.equal(
    formatAgentTurnEvent({ type: "tool_completed", tool: "edit", status: "failed", turnId: "trn_1", seq: 3, at: "now" }),
    '<event seq="3" type="tool_completed" turn="trn_1" tool="edit" status="failed"/>',
  );
});

test("target catalogs list usable targets and explain unavailable providers", () => {
  const catalog: LocalAgentCatalog = {
    enabled: true,
    providers: [
      { id: "codex", driver: "codex", enabled: true, available: true, usable: true, model: "gpt-5.4", effort: "high" },
      {
        id: "claude",
        driver: "claude",
        enabled: true,
        available: false,
        usable: false,
        reason: "credentials missing",
      },
    ],
    profiles: [{
      name: "reviewer",
      description: "Review changes.",
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
    }],
  };

  const targetCatalog = presentAgentTargetCatalog(catalog);
  assert.deepEqual(targetCatalog, {
    enabled: true,
    unavailable: [{ name: "claude", reason: "credentials missing" }],
    targets: [
      { name: "codex", kind: "provider", model: "gpt-5.4", effort: "high" },
      {
        name: "reviewer",
        kind: "profile",
        provider: "codex",
        description: "Review changes.",
        model: "gpt-5.4",
        effort: "high",
      },
    ],
  });
  assert.equal(
    formatAgentTargetCatalog(targetCatalog),
    [
      '<provider name="codex" model="gpt-5.4" effort="high"/>',
      '<profile name="reviewer" provider="codex" model="gpt-5.4" effort="high">Review changes.</profile>',
      '<unavailable name="claude">credentials missing</unavailable>',
    ].join("\n"),
  );
  assert.match(
    formatAgentTargetCatalog(presentAgentTargetCatalog({ ...catalog, enabled: false })),
    /^<disabled>Subagents are disabled/,
  );
});

test("observation exit codes rank failures above stops above timeouts", () => {
  const failure = { code: "AGENT_FAILED", message: "boom", retryable: false };
  assert.equal(agentObservationExitCode([{ id: "a", status: "completed" }]), 0);
  assert.equal(agentObservationExitCode([{ id: "a", status: "running", wait: "timeout" }]), 4);
  assert.equal(agentObservationExitCode([{ id: "a", status: "stopped" }]), 3);
  assert.equal(agentObservationExitCode([{ id: "a", status: "failed", error: failure }]), 2);
  assert.equal(
    agentObservationExitCode([
      { id: "a", status: "running", wait: "timeout" },
      { id: "b", status: "stopped" },
      { id: "c", status: "failed", error: failure },
    ]),
    2,
  );
});
