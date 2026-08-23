import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVSPACE_CONFIG_SCHEMA_URL,
  loadDevspaceFiles,
  writeDevspaceConfig,
} from "./user-config.js";

const legacyRoot = mkdtempSync(join(tmpdir(), "devspace-legacy-config-test-"));
writeFileSync(
  join(legacyRoot, "config.json"),
  JSON.stringify({
    host: "127.0.0.1",
    port: 8787,
    publicBaseUrl: "https://legacy.example.com",
    artifactsEnabled: true,
    artifactMaxFileBytes: 123,
    futureLegacyKey: { keep: true },
  }, null, 2),
);

const legacyFiles = loadDevspaceFiles({ DEVSPACE_CONFIG_DIR: legacyRoot });
assert.equal(legacyFiles.jsoncConfigExists, false);
assert.equal(legacyFiles.legacyConfigExists, true);
assert.deepEqual(legacyFiles.config.server, {
  host: "127.0.0.1",
  port: 8787,
  publicBaseUrl: "https://legacy.example.com",
});
assert.deepEqual(legacyFiles.config.artifacts, {
  enabled: true,
  maxFileBytes: 123,
});

writeDevspaceConfig({
  ...legacyFiles.config,
  server: {
    ...legacyFiles.config.server,
    publicBaseUrl: "https://jsonc.example.com",
  },
}, { DEVSPACE_CONFIG_DIR: legacyRoot }, legacyFiles);

const migratedPath = join(legacyRoot, "config.jsonc");
assert.equal(existsSync(migratedPath), true);
assert.equal(existsSync(join(legacyRoot, "config.json")), true);
const migrated = readFileSync(migratedPath, "utf8");
assert.match(migrated, /"\$schema": "https:\/\/raw\.githubusercontent\.com/);
assert.match(migrated, /"version": 1/);
assert.match(migrated, /"publicBaseUrl": "https:\/\/jsonc\.example\.com"/);

const jsoncRoot = mkdtempSync(join(tmpdir(), "devspace-jsonc-config-test-"));
const jsoncPath = join(jsoncRoot, "config.jsonc");
writeFileSync(jsoncPath, `{
  // Keep this top-level comment.
  "$schema": "${DEVSPACE_CONFIG_SCHEMA_URL}",
  "version": 1,
  "server": {
    // Keep this server comment.
    "host": "127.0.0.1",
    "futureSetting": true,
  },
  "harness": {
    "kind": "claude-code",
    "inspection": "shell",
    "futureHarnessSetting": true,
  },
  "futureTopLevel": {
    "keep": true,
  },
}
`);
writeFileSync(join(jsoncRoot, "config.json"), JSON.stringify({ port: 9999 }));

const jsoncFiles = loadDevspaceFiles({ DEVSPACE_CONFIG_DIR: jsoncRoot });
assert.equal(jsoncFiles.jsoncConfigExists, true);
assert.equal(jsoncFiles.legacyConfigExists, true);
assert.equal(jsoncFiles.config.server?.host, "127.0.0.1");
assert.equal(jsoncFiles.config.server?.port, undefined);

writeDevspaceConfig({
  ...jsoncFiles.config,
  harness: { kind: "codex" },
  server: {
    ...jsoncFiles.config.server,
    publicBaseUrl: "https://preserved.example.com",
  },
}, { DEVSPACE_CONFIG_DIR: jsoncRoot }, jsoncFiles);

const rewritten = readFileSync(jsoncPath, "utf8");
assert.match(rewritten, /Keep this top-level comment/);
assert.match(rewritten, /Keep this server comment/);
assert.match(rewritten, /"futureSetting": true/);
assert.match(rewritten, /"futureHarnessSetting": true/);
assert.match(rewritten, /"futureTopLevel"/);
assert.doesNotMatch(rewritten, /"inspection":/);
assert.match(rewritten, /"publicBaseUrl": "https:\/\/preserved\.example\.com"/);
assert.deepEqual(loadDevspaceFiles({ DEVSPACE_CONFIG_DIR: jsoncRoot }).config.harness, { kind: "codex" });

const malformedRoot = mkdtempSync(join(tmpdir(), "devspace-malformed-jsonc-test-"));
writeFileSync(join(malformedRoot, "config.jsonc"), "{ version: 1,, }");
assert.throws(
  () => loadDevspaceFiles({ DEVSPACE_CONFIG_DIR: malformedRoot }),
  /Unable to read .*config\.jsonc/,
);
