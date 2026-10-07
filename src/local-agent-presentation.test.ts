import assert from "node:assert/strict";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import {
  presentAgentObservation,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

const failed: LocalAgentRecord = {
  id: "agt_test",
  workspaceRoot: "/private/project",
  profileName: "reviewer",
  provider: "codex",
  status: "error",
  error: "Provider disconnected.",
  errorCode: "PROVIDER_EXECUTION_ERROR",
  errorRetryable: true,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:01:00.000Z",
};

assert.deepEqual(presentAgentObservation(failed), {
  id: "agt_test",
  status: "failed",
  error: {
    code: "PROVIDER_EXECUTION_ERROR",
    message: "Provider disconnected.",
    retryable: true,
  },
});

const catalog: LocalAgentCatalog = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, available: true, usable: true, model: "gpt-5.4", effort: "high" },
    { id: "claude", enabled: true, available: false, usable: false },
  ],
  profiles: [{
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
  }],
};

assert.deepEqual(presentAgentTargetCatalog(catalog), {
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
