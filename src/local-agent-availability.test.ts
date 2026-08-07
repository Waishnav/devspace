import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";

const availableCodex = checkLocalAgentProviderAvailability("codex");
assert.equal(availableCodex.available, true);
assert.match(availableCodex.version ?? "", /^\d+\.\d+/);
assert.equal(availableCodex.minimumVersion, "0.142.5");

{
  const availability = checkLocalAgentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: "/definitely/missing/devspace-codex",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-codex-test-"));
  const oldCodex = join(directory, "codex");
  writeFileSync(oldCodex, "#!/bin/sh\necho 'codex-cli 0.130.0'\n", { mode: 0o755 });
  chmodSync(oldCodex, 0o755);

  const availability = checkLocalAgentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: oldCodex,
  });
  assert.equal(availability.available, false);
  assert.equal(availability.version, "0.130.0");
  assert.equal(availability.minimumVersion, "0.142.5");
  assert.match(availability.reason ?? "", /below the minimum supported version 0\.142\.5/);
}

{
  const availability = checkLocalAgentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true, version: "0.147.0", minimumVersion: "0.142.5" },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex (0.147.0, min 0.142.5); unavailable: pi (pi executable not found)",
);
