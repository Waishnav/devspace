import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { loadAgentConfig, loadConfig } from "./config.js";
import { writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

const ownerToken = "test-owner-token-that-is-long-enough";

function tempConfigDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function serverConfigDir(t: TestContext) {
  const configDir = tempConfigDir(t, "devspace-config-test-");

  return { configDir, env: { DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken } };
}

// Defaults are a security boundary: loopback only, nothing proxied, privacy-sensitive logging off.
test("an empty config dir loads secure-by-default server config", (t) => {
  const { env } = serverConfigDir(t);
  const defaults = loadConfig(env);
  assert.equal(defaults.host, "127.0.0.1");
  assert.deepEqual(defaults.allowedRoots, [process.cwd()]);
  assert.deepEqual(defaults.allowedHosts, ["localhost", "127.0.0.1", "::1"]);
  assert.equal(defaults.experimentalCodeMode, false);
  assert.equal(defaults.artifactsEnabled, false);
  assert.equal(defaults.subagents.enabled, false);
  assert.deepEqual(defaults.oauth.allowedResourceUrls, []);
  assert.deepEqual(defaults.oauth.allowedRedirectHosts, ["chatgpt.com", "claude.ai", "claude.com", "localhost", "127.0.0.1"]);
  assert.equal(defaults.oauth.refreshTokenGraceSeconds, 0);
  assert.equal(defaults.logging.shellCommands, false);
  assert.equal(defaults.logging.trustProxy, false);
});

test("DEVSPACE_EXPERIMENTAL_CODE_MODE toggles experimental code mode", (t) => {
  const { env } = serverConfigDir(t);
  assert.equal(loadConfig({ ...env, DEVSPACE_EXPERIMENTAL_CODE_MODE: "1" }).experimentalCodeMode, true);
  assert.equal(loadConfig({ ...env, DEVSPACE_EXPERIMENTAL_CODE_MODE: "0" }).experimentalCodeMode, false);
});

test("the config file and persisted auth configure the server, and the env owner token wins", (t) => {
  const { configDir, env } = serverConfigDir(t);
  writeDevspaceConfig({
    configVersion: 1,
    server: {
      host: "0.0.0.0",
      port: 8787,
      publicBaseUrl: "https://devspace.example.com/",
      allowedHosts: ["example.internal"],
      trustProxy: true,
    },
    workspaces: {
      allowedRoots: ["~/work"],
      worktreeRoot: "~/trees",
    },
    storage: { stateDir: "~/state" },
    tools: { mode: "claude" },
    ui: { enabled: false },
    artifacts: { enabled: true, maxFileBytes: 321 },
    skills: { enabled: false, paths: ["~/skills"], agentDir: "~/agent" },
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
    logging: {
      level: "debug",
      format: "pretty",
      requests: false,
      assets: true,
      toolCalls: false,
      shellCommands: true,
    },
    oauth: {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 240,
      refreshTokenGraceSeconds: 60,
      scopes: ["devspace", "admin"],
      allowedResourceUrls: ["https://tunnel.example.com/v1/mcp/tunnel_123"],
      allowedRedirectHosts: ["chatgpt.com", "example.com"],
    },
  }, env);
  writeDevspaceAuth({ ownerToken: "persisted-owner-token-long-enough" }, env);

  const configured = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
  assert.equal(configured.configDir, configDir);
  assert.equal(configured.host, "0.0.0.0");
  assert.equal(configured.port, 8787);
  assert.equal(configured.publicBaseUrl, "https://devspace.example.com");
  assert.deepEqual(configured.allowedRoots, [resolve(homedir(), "work")]);
  assert.deepEqual(configured.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "devspace.example.com",
    "example.internal",
  ]);
  assert.equal(configured.toolSurfaceOverride, "claude");
  assert.equal(configured.uiEnabled, false);
  assert.equal(configured.stateDir, resolve(homedir(), "state"));
  assert.equal(configured.worktreeRoot, resolve(homedir(), "trees"));
  assert.equal(configured.artifactsEnabled, true);
  assert.equal(configured.artifactMaxFileBytes, 321);
  assert.equal(configured.skillsEnabled, false);
  assert.deepEqual(configured.skillPaths, ["~/skills"]);
  assert.equal(configured.agentDir, resolve(homedir(), "agent"));
  assert.equal(configured.subagents.enabled, true);
  assert.equal(configured.subagents.instructions, "preload");
  assert.equal(configured.oauth.ownerToken, "persisted-owner-token-long-enough");
  assert.equal(configured.oauth.accessTokenTtlSeconds, 120);
  assert.equal(configured.oauth.refreshTokenGraceSeconds, 60);
  assert.deepEqual(configured.oauth.scopes, ["devspace", "admin"]);
  assert.deepEqual(configured.oauth.allowedResourceUrls, [
    "https://tunnel.example.com/v1/mcp/tunnel_123",
  ]);
  assert.deepEqual(configured.logging, {
    level: "debug",
    format: "pretty",
    requests: false,
    assets: true,
    toolCalls: false,
    shellCommands: true,
    trustProxy: true,
  });

  assert.equal(loadConfig(env).oauth.ownerToken, env.DEVSPACE_OAUTH_OWNER_TOKEN);
});

test("server.trustProxy accepts loopback and rejects unsupported presets", (t) => {
  const { env } = serverConfigDir(t);
  writeDevspaceConfig({ configVersion: 1, server: { trustProxy: "loopback" } }, env);
  assert.equal(loadConfig(env).logging.trustProxy, "loopback");
  assert.throws(
    // SAFETY: The surrounding checks or construction already match this type.
    () => writeDevspaceConfig({ configVersion: 1, server: { trustProxy: "uniquelocal" as never } }, env),
    /trustProxy/,
  );
});

test("a config file that omits subagents disables them for the server but not for agent commands", (t) => {
  const unconfiguredDir = tempConfigDir(t, "devspace-config-unconfigured-test-");
  const serverEnv = { DEVSPACE_CONFIG_DIR: unconfiguredDir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough" };
  writeDevspaceConfig({ configVersion: 1 }, serverEnv);
  assert.equal(loadConfig(serverEnv).subagents.enabled, false);
  assert.equal(loadAgentConfig(serverEnv).subagents.enabled, true, "a config file that omits subagents stays unconfigured");
});

test("the server requires an OAuth owner token", (t) => {
  const missingAuthDir = tempConfigDir(t, "devspace-config-no-auth-test-");
  assert.throws(
    () => loadConfig({ DEVSPACE_CONFIG_DIR: missingAuthDir }),
    /OAuth owner token is required/,
  );
});

// Agent commands need no server setup. Without a subagents key every built-in provider is on.
test("agent commands enable every built-in provider without a subagents key", (t) => {
  const missingAuthDir = tempConfigDir(t, "devspace-config-no-auth-test-");
  const implicit = loadAgentConfig({ DEVSPACE_CONFIG_DIR: missingAuthDir }).subagents;
  assert.equal(implicit.enabled, true);
  assert.deepEqual(
    implicit.providers.map((provider) => provider.id),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot", "grok"],
  );
  assert.ok(implicit.providers.every((provider) => provider.enabled));
});

// An explicit subagents config wins, including enabled: false; the server never opts in implicitly.
test("an explicit subagents config wins for agent commands", (t) => {
  const missingAuthDir = tempConfigDir(t, "devspace-config-no-auth-test-");
  writeDevspaceConfig({
    configVersion: 1,
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }, { DEVSPACE_CONFIG_DIR: missingAuthDir });
  assert.equal(loadAgentConfig({ DEVSPACE_CONFIG_DIR: missingAuthDir }).subagents.enabled, false);
});
