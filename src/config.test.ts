import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";

test("configuration defaults keep optional capabilities disabled", async (t) => {
  const { configDir, env } = await configEnvironment(t);
  const config = loadConfig(env);

  assert.equal(config.widgets, "full");
  assert.equal(config.toolMode, "minimal");
  assert.equal(config.skillsEnabled, true);
  assert.equal(config.devspaceSkillsDir, join(configDir, "skills"));
  assert.equal(config.devspaceAgentsDir, join(configDir, "agents"));
  assert.deepEqual(config.subagents, { enabled: false, providers: [] });
  assert.equal(config.artifactsEnabled, false);
  assert.equal(config.artifactMaxFileBytes, 100 * 1024 * 1024);
});

test("environment options enable supported tool and feature modes", async (t) => {
  const { env } = await configEnvironment(t);

  assert.equal(loadConfig({ ...env, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
  assert.equal(loadConfig({ ...env, DEVSPACE_WIDGETS: "off" }).widgets, "off");
  assert.equal(loadConfig({ ...env, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
  assert.equal(loadConfig({ ...env, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
  assert.equal(loadConfig({ ...env, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
  assert.equal(loadConfig({ ...env, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
  assert.equal(loadConfig({ ...env, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
  assert.equal(
    loadConfig({ ...env, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
    123,
  );
  assert.deepEqual(loadConfig({ ...env, DEVSPACE_SUBAGENTS: "1" }).subagents, {
    enabled: true,
    providers: [],
  });
});

test("invalid configuration fails at the environment boundary", async (t) => {
  const { configDir, env } = await configEnvironment(t);

  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_WIDGETS: "invalid" }),
    /Invalid DEVSPACE_WIDGETS: invalid/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_TOOL_MODE: "invalid" }),
    /Invalid DEVSPACE_TOOL_MODE: invalid/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_LOG_LEVEL: "trace" }),
    /Invalid DEVSPACE_LOG_LEVEL: trace/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_LOG_FORMAT: "color" }),
    /Invalid DEVSPACE_LOG_FORMAT: color/,
  );
  assert.throws(
    () => loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
    /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
    /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
    /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
  );
  assert.throws(
    () => loadConfig({ ...env, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
    /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
  );
});

test("logging configuration preserves explicit operational choices", async (t) => {
  const { env } = await configEnvironment(t);

  assert.deepEqual(loadConfig(env).logging, {
    level: "info",
    format: "json",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
  });

  const configured = loadConfig({
    ...env,
    DEVSPACE_LOG_LEVEL: "debug",
    DEVSPACE_LOG_FORMAT: "pretty",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_ASSETS: "1",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    DEVSPACE_LOG_SHELL_COMMANDS: "1",
    DEVSPACE_TRUST_PROXY: "1",
  });
  assert.deepEqual(configured.logging, {
    level: "debug",
    format: "pretty",
    requests: false,
    assets: true,
    toolCalls: false,
    shellCommands: true,
    trustProxy: true,
  });
});

test("OAuth and public URL configuration define the server authority boundary", async (t) => {
  const { env } = await configEnvironment(t);
  const defaults = loadConfig(env);

  assert.equal(defaults.oauth.ownerToken, "test-owner-token-that-is-long-enough");
  assert.deepEqual(defaults.oauth.scopes, ["devspace"]);
  assert.deepEqual(defaults.oauth.allowedRedirectHosts, ["chatgpt.com", "localhost", "127.0.0.1"]);
  assert.equal(defaults.oauth.accessTokenTtlSeconds, 3600);
  assert.equal(defaults.oauth.refreshTokenTtlSeconds, 2592000);
  assert.equal(defaults.publicBaseUrl, "http://127.0.0.1:7676");
  assert.deepEqual(defaults.allowedHosts, ["localhost", "127.0.0.1", "::1"]);

  const configured = loadConfig({
    ...env,
    DEVSPACE_OAUTH_SCOPES: "devspace,admin",
    DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com",
    DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120",
    DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240",
    DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/",
  });
  assert.deepEqual(configured.oauth.scopes, ["devspace", "admin"]);
  assert.deepEqual(configured.oauth.allowedRedirectHosts, ["chatgpt.com", "example.com"]);
  assert.equal(configured.oauth.accessTokenTtlSeconds, 120);
  assert.equal(configured.oauth.refreshTokenTtlSeconds, 240);
  assert.equal(configured.publicBaseUrl, "https://abc.trycloudflare.com");
  assert.deepEqual(configured.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "abc.trycloudflare.com",
  ]);
  assert.deepEqual(loadConfig({ ...env, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts, ["*"]);
});

test("persisted configuration is restored through the public loader", async (t) => {
  const configDir = await temporaryDirectory(t, "devspace-config-test-");
  await writeFile(
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
  await writeFile(
    join(configDir, "auth.json"),
    JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
  );

  const config = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
  assert.equal(config.port, 8787);
  assert.equal(config.oauth.ownerToken, "persisted-owner-token-long-enough");
  assert.equal(config.publicBaseUrl, "https://devspace.example.com");
  assert.equal(config.subagents.enabled, true);
  assert.equal(config.artifactsEnabled, true);
  assert.equal(config.artifactMaxFileBytes, 321);
  assert.deepEqual(config.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "devspace.example.com",
  ]);
});

async function configEnvironment(t: TestContext) {
  const configDir = await temporaryDirectory(t, "devspace-empty-config-test-");
  return {
    configDir,
    env: {
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: process.cwd(),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  };
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
