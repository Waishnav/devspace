import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const configCommandRoot = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));
try {
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "config", "set", "requiredToolMode", "codex"], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandRoot },
  });
  assert.equal(
    JSON.parse(readFileSync(join(configCommandRoot, "config.json"), "utf8")).requiredToolMode,
    "codex",
  );
} finally {
  rmSync(configCommandRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const authRoot = mkdtempSync(join(tmpdir(), "devspace-cli-auth-test-"));
try {
  const stateDir = join(authRoot, ".state");
  const projectRoot = join(authRoot, "project");
  mkdirSync(projectRoot, { recursive: true });

  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, ["chatgpt.com"]).registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    client_name: "ChatGPT",
  });
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  store.saveTokenPair({
    accessTokenHash: "cli-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
    refreshTokenHash: "cli-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
  });
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "auth", "reset"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: join(authRoot, ".devspace"),
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });
  assert.match(output, /1 client\(s\), 1 access token\(s\), 1 refresh token\(s\) removed/);

  const reopened = new SqliteOAuthStore(stateDir);
  assert.equal(reopened.getClient(client.client_id), undefined);
  assert.equal(reopened.getAccessToken("cli-access-hash"), undefined);
  assert.equal(reopened.getRefreshToken("cli-refresh-hash"), undefined);
  reopened.close();
} finally {
  rmSync(authRoot, { recursive: true, force: true });
}
