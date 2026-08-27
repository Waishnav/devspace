import assert from "node:assert/strict";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";

{
  const availability = checkLocalAgentProviderAvailability("codex");
  assert.equal(availability.name, "codex");
  assert.equal(typeof availability.available, "boolean");
  if (availability.available) {
    assert.equal(availability.note, "available");
  }
}

{
  const availability = checkLocalAgentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: "/definitely/missing/devspace-codex",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  assert.equal(checkLocalAgentProviderAvailability("pi").available, true);
}

{
  const snapshot = getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    CODEX_COMMAND: "/definitely/missing/devspace-codex",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot", "grok"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, true);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true, note: "available" },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex (available); unavailable: pi (pi executable not found)",
);
