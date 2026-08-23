import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
} from "./local-agent-availability.js";

test("a configured provider command reports a useful missing-executable failure", () => {
  const availability = checkLocalAgentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: "/definitely/missing/devspace-codex",
  });

  assert.deepEqual(availability, {
    name: "codex",
    available: false,
    reason: "/definitely/missing/devspace-codex executable not found",
  });
});

test("the availability summary separates usable and unusable providers", () => {
  assert.equal(
    formatLocalAgentProviderAvailabilitySummary([
      { name: "codex", available: true, note: "available" },
      { name: "pi", available: false, reason: "pi executable not found" },
    ]),
    "available: codex (available); unavailable: pi (pi executable not found)",
  );
});
