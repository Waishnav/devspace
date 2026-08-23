import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.deepEqual(loadConfig(baseEnv).presentation, { mode: "inline" });
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).presentation, {
  mode: "change-review",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).presentation, {
  mode: "inline",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).presentation, {
  mode: "off",
});
assert.deepEqual(loadConfig(baseEnv).harness, {
  kind: "claude-code",
  inspection: "shell",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).harness, {
  kind: "claude-code",
  inspection: "shell",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).harness, {
  kind: "claude-code",
  inspection: "dedicated",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).harness, {
  kind: "codex",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).harness, {
  kind: "claude-code",
  inspection: "dedicated",
});
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).harness, {
  kind: "claude-code",
  inspection: "shell",
});
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "maybe" }),
  /Invalid DEVSPACE_MINIMAL_TOOLS: maybe/,
);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.deepEqual(loadConfig(baseEnv).subagents, { enabled: false, providers: [] });
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "treu" }),
  /Invalid DEVSPACE_SKILLS: treu/,
);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents, {
  enabled: true,
  providers: [],
});
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "sometimes" }),
  /Invalid DEVSPACE_SUBAGENTS: sometimes/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents.enabled, true);
assert.equal(fileConfig.subagents.providers.length, 7);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);

const jsoncConfigDir = mkdtempSync(join(tmpdir(), "devspace-jsonc-load-config-test-"));
writeFileSync(
  join(jsoncConfigDir, "config.jsonc"),
  `{
    // Structured v1 configuration.
    "version": 1,
    "server": {
      "port": 8989,
      "allowedRoots": [${JSON.stringify(process.cwd())}],
      "publicBaseUrl": "https://jsonc.devspace.example.com"
    },
    "harness": {
      "kind": "codex"
    },
    "presentation": {
      "mode": "change-review"
    },
    "skills": {
      "enabled": false,
      "paths": ["~/.custom-skills"]
    },
    "artifacts": {
      "enabled": true,
      "maxFileBytes": 456
    },
    "logging": {
      "level": "debug",
      "requests": false
    },
    "oauth": {
      "accessTokenTtlSeconds": 120,
      "scopes": ["devspace", "admin"]
    }
  }`,
);
writeFileSync(
  join(jsoncConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "jsonc-owner-token-long-enough" }),
);

const jsoncConfig = loadConfig({ DEVSPACE_CONFIG_DIR: jsoncConfigDir });
assert.equal(jsoncConfig.port, 8989);
assert.equal(jsoncConfig.publicBaseUrl, "https://jsonc.devspace.example.com");
assert.deepEqual(jsoncConfig.harness, { kind: "codex" });
assert.deepEqual(jsoncConfig.presentation, { mode: "change-review" });
assert.equal(jsoncConfig.skillsEnabled, false);
assert.deepEqual(jsoncConfig.skillPaths, ["~/.custom-skills"]);
assert.equal(jsoncConfig.artifactsEnabled, true);
assert.equal(jsoncConfig.artifactMaxFileBytes, 456);
assert.equal(jsoncConfig.logging.level, "debug");
assert.equal(jsoncConfig.logging.requests, false);
assert.equal(jsoncConfig.oauth.accessTokenTtlSeconds, 120);
assert.deepEqual(jsoncConfig.oauth.scopes, ["devspace", "admin"]);

const envOverride = loadConfig({
  DEVSPACE_CONFIG_DIR: jsoncConfigDir,
  DEVSPACE_TOOL_MODE: "full",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "1",
  DEVSPACE_LOG_LEVEL: "warn",
});
assert.deepEqual(envOverride.harness, { kind: "claude-code", inspection: "dedicated" });
assert.deepEqual(envOverride.presentation, { mode: "off" });
assert.equal(envOverride.skillsEnabled, true);
assert.equal(envOverride.logging.level, "warn");
