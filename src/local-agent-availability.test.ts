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
// Without `pi` on PATH, Pi runs from the copy bundled in this package.
assert.equal(
  getLocalAgentProviderAvailabilitySnapshot({ PATH: "" }).find((provider) => provider.name === "pi")?.available,
  true,
);
assert.equal(
  getLocalAgentProviderAvailabilitySnapshot({ ...process.env, CODEX_COMMAND: "" })
    .find((provider) => provider.name === "codex")?.available,
  false,
);

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-provider-command-"));
  const executable = join(directory, "codex-wrapper");
  try {
    assert.equal(
      getLocalAgentProviderAvailabilitySnapshot({
        ...process.env,
        CODEX_COMMAND: directory,
      }).find((provider) => provider.name === "codex")?.available,
      false,
    );
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
        instructions: "on-demand",
        providers: [{
          id: "codex",
          driver: "codex",
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

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-acp-availability-"));
  try {
    const grok = join(directory, "grok");
    writeFileSync(grok, "#!/bin/sh\nexit 0\n");
    chmodSync(grok, 0o700);
    const env = { PATH: directory };
    const config = {
      enabled: true,
      instructions: "on-demand" as const,
      providers: [
        { id: "cursor", driver: "acp" as const, enabled: true, config: { flavor: "cursor" as const } },
        { id: "cursor-work", driver: "acp" as const, enabled: true, config: { flavor: "grok" as const } },
        { id: "kiro", driver: "acp" as const, enabled: true, command: "kiro" },
      ],
    };
    const snapshot = getLocalAgentProviderAvailabilitySnapshot(env, config);
    assert.deepEqual(snapshot.filter((provider) => provider.name === "cursor").length, 1, "configured built-in ACP ids are listed once");
    assert.equal(snapshot.find((provider) => provider.name === "cursor-work")?.available, true, "preflight checks the flavor's executable");
    assert.equal(snapshot.find((provider) => provider.name === "kiro")?.reason, "kiro executable not found");
    assert.equal(snapshot.find((provider) => provider.name === "cursor")?.available, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-pi-availability-"));
  try {
    const pi = join(directory, "pi");
    writeFileSync(pi, "#!/bin/sh\nexit 0\n");
    chmodSync(pi, 0o700);
    const availability = (env: NodeJS.ProcessEnv) => getLocalAgentProviderAvailabilitySnapshot(env)
      .find((provider) => provider.name === "pi");
    assert.equal(availability({ PATH: directory })?.available, true, "a system pi on PATH is launchable");
    assert.equal(availability({ PATH: directory, PI_COMMAND: "/definitely/missing/pi" })?.available, false);
    assert.match(availability({ PATH: directory, PI_COMMAND: "/definitely/missing/pi" })?.reason ?? "", /missing\/pi/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
