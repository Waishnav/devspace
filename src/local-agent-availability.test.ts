import assert from "node:assert/strict";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/devspace-codex",
  ANTIGRAVITY_COMMAND: "/definitely/missing/devspace-antigravity",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "codex"), {
  name: "codex",
  available: false,
  reason: "/definitely/missing/devspace-codex executable not found",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "antigravity"), {
  name: "antigravity",
  available: false,
  reason: "/definitely/missing/devspace-antigravity executable not found",
});
