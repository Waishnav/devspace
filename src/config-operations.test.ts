import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigShowResult,
  resetConfigKey,
  setConfigDomain,
  setConfigHost,
  setConfigPort,
  setConfigPublicBaseUrl,
} from "./config-operations.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { loadDevspaceFiles, writeDevspaceAuth } from "./user-config.js";

const root = mkdtempSync(join(tmpdir(), "devspace-config-operations-test-"));
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

  const domainResult = setConfigDomain("devspace.example.com/mcp");
  assert.equal(loadDevspaceFiles().config.publicBaseUrl, "https://devspace.example.com");
  assert.equal(domainResult.warning, undefined);
  assert.match(setConfigDomain("http://devspace.example.com").warning ?? "", /Prefer HTTPS/);
  assert.throws(() => setConfigDomain("https://devspace.example.com/custom-mcp"), /origin/);
  assert.throws(() => setConfigDomain("ftp://devspace.example.com"), /http or https/);

  setConfigPublicBaseUrl("none");
  assert.equal(loadDevspaceFiles().config.publicBaseUrl, null);

  writeDevspaceAuth({ ownerToken: "old-owner-token-that-is-long-enough" });
  const store = new SqliteOAuthStore(process.env.DEVSPACE_STATE_DIR);
  const client = new SqliteOAuthClientsStore(store, ["chatgpt.com"]).registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  });
  store.close();

  const reset = resetConfigKey();
  assert.notEqual(reset.ownerToken, "old-owner-token-that-is-long-enough");
  assert.equal(loadDevspaceFiles().auth.ownerToken, reset.ownerToken);

  const clearedStore = new SqliteOAuthStore(process.env.DEVSPACE_STATE_DIR);
  try {
    assert.equal(clearedStore.getClient(client.client_id), undefined);
  } finally {
    clearedStore.close();
  }

  const shown = buildConfigShowResult();
  assert.notEqual(shown.accessKey, reset.ownerToken);
  assert.match(shown.accessKey, /^.{3}\*+/);

  assert.throws(
    () => resetConfigKey({ ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: "environment-owner-token" }),
    /Cannot rotate the persisted Owner password/,
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

    assert.throws(() => resetConfigKey(brokenEnv), /EEXIST/);
    assert.equal(readFileSync(loadDevspaceFiles(brokenEnv).authPath, "utf8"), authBeforeFailure);
  } finally {
    rmSync(brokenStateRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_CONFIG_DIR;
  delete process.env.DEVSPACE_STATE_DIR;
}
