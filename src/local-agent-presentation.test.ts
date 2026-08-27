import assert from "node:assert/strict";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import {
  formatAgentObservation,
  formatAgentSummary,
  formatAgentTargetCatalog,
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
  provider: "codex",
  model: "gpt-5.4",
  effort: "high",
  providerSessionId: "provider_private",
  status: "running",
  latestResponse: "previous response",
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:01:00.000Z",
};

assert.deepEqual(presentAgentReceipt({ ...record, status: "starting" }), {
  id: "agt_test",
  status: "running",
});
assert.deepEqual(presentAgentSummary({ ...record, status: "idle" }), {
  id: "agt_test",
  status: "completed",
  target: "reviewer",
});
assert.equal(formatAgentSummary(presentAgentSummary(record)), "agt_test running reviewer");

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
assert.equal(formatAgentObservation(completed), "agt_test completed\n\nFound one issue.");

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
assert.equal(
  formatAgentObservation(failed),
  "agt_test failed PROVIDER_EXECUTION_ERROR: Provider disconnected. [retryable]",
);

const catalog: LocalAgentCatalog = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, available: true, usable: true, model: "gpt-5.4", effort: "high" },
    {
      id: "claude",
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
    "codex [provider] model=gpt-5.4 effort=high",
    "reviewer [profile, codex] model=gpt-5.4 effort=high - Review changes.",
  ].join("\n"),
);
