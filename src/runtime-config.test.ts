import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { compileRuntime } from "./runtime-config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-runtime-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

const minimal = compileRuntime(loadConfig(baseEnv), { artifactDownloadSupported: true });
assert.deepEqual(minimal.runtimeHarness.toolGroups, ["write-edit", "bash"]);

const full = compileRuntime(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }),
  { artifactDownloadSupported: true },
);
assert.deepEqual(full.runtimeHarness.toolGroups, ["write-edit", "dedicated-inspection", "bash"]);

const codex = compileRuntime(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }),
  { artifactDownloadSupported: true },
);
assert.deepEqual(codex.runtimeHarness.toolGroups, ["apply-patch", "process-session"]);

assert.deepEqual(minimal.artifactCapability, {
  status: "unavailable",
  reason: "disabled",
});

const unsupportedArtifacts = compileRuntime(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }),
  { artifactDownloadSupported: false },
);
assert.deepEqual(unsupportedArtifacts.artifactCapability, {
  status: "unavailable",
  reason: "unsupported-platform",
});

const availableArtifacts = compileRuntime(
  loadConfig({
    ...baseEnv,
    DEVSPACE_ARTIFACTS: "1",
    DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123",
  }),
  { artifactDownloadSupported: true },
);
assert.deepEqual(availableArtifacts.artifactCapability, {
  status: "available",
  maxFileBytes: 123,
});
