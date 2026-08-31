import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/devspace-codex",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "codex"), {
  name: "codex",
  available: false,
  reason: "/definitely/missing/devspace-codex executable not found",
});

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-provider-command-"));
  const executable = join(directory, "codex-wrapper");
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      {
        ...process.env,
        CODEX_COMMAND: "/definitely/missing/devspace-codex",
        OPENAI_API_KEY: "must-not-appear",
      },
      {
        enabled: true,
        providers: [{
          id: "codex",
          enabled: true,
          command: executable,
          env: { OPENAI_API_KEY: "configured-secret", EMPTY_VALUE: "" },
        }],
      },
    ).find((provider) => provider.name === "codex");
    assert.deepEqual(availability, {
      name: "codex",
      available: true,
      note: "available",
    });
    assert.doesNotMatch(JSON.stringify(availability), /configured-secret|must-not-appear/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
