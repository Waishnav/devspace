import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigShowResult,
  setConfigDomain,
  setConfigHost,
  setConfigKey,
  setConfigPort,
  setConfigPublicBaseUrl,
} from "./config-operations.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { loadDevspaceFiles, writeDevspaceAuth } from "./user-config.js";

const root = mkdtempSync(join(tmpdir(), "devspace-config-operations-test-"));
for (const key of [
  "HOST",
  "PORT",
  "DEVSPACE_ALLOWED_ROOTS",
  "DEVSPACE_ALLOWED_HOSTS",
  "DEVSPACE_OAUTH_OWNER_TOKEN",
  "DEVSPACE_PUBLIC_BASE_URL",
]) {
  delete process.env[key];
}
process.env.DEVSPACE_CONFIG_DIR = join(root, "config");
process.env.DEVSPACE_STATE_DIR = join(root, "state");

try {
  const initial = buildConfigShowResult();
  assert.equal(initial.host, "127.0.0.1");
  assert.equal(initial.port, 7676);
  assert.equal(initial.publicUrl, "http://127.0.0.1:7676/mcp");
  assert.equal(initial.accessKey, "(not configured)");

  assert.match(setConfigPort("8787").message, /8787/);
  assert.equal(loadDevspaceFiles().config.port, 8787);
  assert.throws(() => setConfigPort("0"), /between 1 and 65535/);

  const hostResult = setConfigHost("0.0.0.0");
  assert.equal(loadDevspaceFiles().config.host, "0.0.0.0");
  assert.match(hostResult.warning ?? "", /may expose DevSpace/);
  assert.throws(() => setConfigHost("https://example.com"), /Invalid host/);
  assert.throws(() => setConfigHost("a..example.com"), /Invalid host/);
  assert.throws(() => setConfigHost("api-.example.com"), /Invalid host/);
  assert.throws(() => setConfigHost(`${"a".repeat(64)}.example.com`), /Invalid host/);

  const domainResult = setConfigDomain("devspace.example.com");
  assert.equal(loadDevspaceFiles().config.publicBaseUrl, "https://devspace.example.com");
  assert.equal(domainResult.warning, undefined);
  assert.throws(() => setConfigDomain("devspace.example.com/mcp"), /Domain must be a hostname/);
  assert.throws(() => setConfigDomain("localhost:8443"), /Domain must be a hostname/);
  assert.throws(() => setConfigDomain("https://devspace.example.com"), /Domain must be a hostname/);

  const legacyPublicBaseUrl = setConfigPublicBaseUrl("https://legacy.example.com:8443/path/?query=value#fragment");
  assert.equal(loadDevspaceFiles().config.publicBaseUrl, "https://legacy.example.com:8443/path");
  assert.match(legacyPublicBaseUrl.message, /https:\/\/legacy\.example\.com:8443\/path\/mcp/);
  assert.equal(buildConfigShowResult().publicUrl, "https://legacy.example.com:8443/path/mcp");
  assert.throws(() => setConfigPublicBaseUrl("ftp://legacy.example.com"), /must use http or https/);
  assert.throws(() => setConfigPublicBaseUrl("not a URL"), /valid http or https URL/);

  setConfigPublicBaseUrl("none");
  assert.equal(loadDevspaceFiles().config.publicBaseUrl, null);

  writeDevspaceAuth({ ownerToken: "old-owner-token-that-is-long-enough" });
  const store = new SqliteOAuthStore(process.env.DEVSPACE_STATE_DIR);
  const client = new SqliteOAuthClientsStore(store, ["chatgpt.com"]).registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  });
  store.close();

  const newOwnerPassword = "new-owner-password-for-test";
  const update = setConfigKey(newOwnerPassword);
  assert.ok(update.authPath.endsWith("auth.json"));
  assert.equal(loadDevspaceFiles().auth.ownerToken, newOwnerPassword);

  const clearedStore = new SqliteOAuthStore(process.env.DEVSPACE_STATE_DIR);
  try {
    assert.equal(clearedStore.getClient(client.client_id), undefined);
  } finally {
    clearedStore.close();
  }

  const shown = buildConfigShowResult();
  assert.equal(shown.accessKey, "********");

  assert.throws(() => setConfigKey(""), /Owner password is required/);
  assert.throws(() => setConfigKey("too-short"), /at least 16 characters/);
  assert.throws(
    () => setConfigKey("new-owner-password-for-test", { ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: "environment-owner-token" }),
    /Cannot update the persisted Owner password/,
  );

  const brokenStateRoot = mkdtempSync(join(tmpdir(), "devspace-config-broken-state-"));
  try {
    const brokenStatePath = join(brokenStateRoot, "state-file");
    writeFileSync(brokenStatePath, "{}");

    const brokenEnv = {
      ...process.env,
      DEVSPACE_CONFIG_DIR: process.env.DEVSPACE_CONFIG_DIR,
      DEVSPACE_STATE_DIR: brokenStatePath,
    };

    writeDevspaceAuth({ ownerToken: "persisted-owner-token-before-failure" }, brokenEnv);
    const authBeforeFailure = readFileSync(loadDevspaceFiles(brokenEnv).authPath, "utf8");

    assert.throws(() => setConfigKey("new-owner-password-for-test", brokenEnv), /EEXIST/);
    assert.equal(readFileSync(loadDevspaceFiles(brokenEnv).authPath, "utf8"), authBeforeFailure);
  } finally {
    rmSync(brokenStateRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_CONFIG_DIR;
  delete process.env.DEVSPACE_STATE_DIR;
}
