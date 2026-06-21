import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorkspace,
  buildConfigShowResult,
  clearDefaultWorkspace,
  listWorkspaces,
  removeWorkspace,
  resetConfigKey,
  setConfigDomain,
  setConfigHost,
  setConfigPort,
  setDefaultWorkspace,
} from "./config-operations.js";
import { loadDevspaceFiles, writeDevspaceAuth } from "./user-config.js";
import type { ServiceManager } from "./service/types.js";

const root = mkdtempSync(join(tmpdir(), "devspace-config-ops-test-"));
process.env.DEVSPACE_CONFIG_DIR = root;
process.env.DEVSPACE_STATE_DIR = join(root, "state");

const testManager: ServiceManager = {
  kind: "unsupported",
  serviceName: "devspace-test",
  async isSupported() {
    return false;
  },
  async remove() {
    return { ok: false, manager: "unsupported", message: "unsupported" };
  },
  async disable() {
    return { ok: false, manager: "unsupported", message: "unsupported" };
  },
  async start() {
    return { ok: false, manager: "unsupported", message: "unsupported" };
  },
  async stop() {
    return { ok: false, manager: "unsupported", message: "unsupported" };
  },
  async restart() {
    return { ok: true, manager: "unsupported", message: "Restarted service" };
  },
  async status() {
    return {
      installed: true,
      enabled: true,
      running: true,
      manager: "unsupported",
      serviceName: "devspace-test",
    };
  },
  async logs() {
    return "";
  },
  async doctor() {
    return { manager: "unsupported", checks: [] };
  },
};

try {
  writeDevspaceAuth({ ownerToken: "test-owner-token-that-is-long-enough" });

  const initialWorkspace = join(root, "workspace-a");
  await addWorkspace(initialWorkspace, { create: true, makeDefault: true });
  const resolvedInitialWorkspace = realpathSync(initialWorkspace);
  let listed = listWorkspaces();
  assert.deepEqual(listed.workspaces, [resolvedInitialWorkspace]);
  assert.equal(listed.defaultWorkspace, resolvedInitialWorkspace);

  const secondWorkspace = join(root, "workspace-b");
  await addWorkspace(secondWorkspace, { create: true });
  const resolvedSecondWorkspace = realpathSync(secondWorkspace);
  await setDefaultWorkspace(secondWorkspace);
  listed = listWorkspaces();
  assert.equal(listed.defaultWorkspace, resolvedSecondWorkspace);

  await clearDefaultWorkspace();
  assert.equal(listWorkspaces().defaultWorkspace, undefined);

  await removeWorkspace(initialWorkspace);
  assert.deepEqual(listWorkspaces().workspaces, [resolvedSecondWorkspace]);

  await setConfigHost("127.0.0.1", import.meta.url, { manager: testManager });
  await setConfigDomain("https://devspace.example.com/custom-mcp", import.meta.url, { manager: testManager });
  const filesAfterDomain = loadDevspaceFiles();
  assert.equal(filesAfterDomain.config.server?.publicBaseUrl, "https://devspace.example.com");
  assert.equal(filesAfterDomain.config.server?.mcpPath, "/custom-mcp");

  const oldToken = loadDevspaceFiles().auth.ownerToken;
  await resetConfigKey(import.meta.url, { manager: testManager });
  const newToken = loadDevspaceFiles().auth.ownerToken;
  assert.notEqual(newToken, oldToken);

  process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "env-owner-token-that-is-long-enough";
  const shown = await buildConfigShowResult(import.meta.url, { manager: testManager });
  assert.match(shown.accessKey, /^env\*+/);
  delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;

  await assert.rejects(() => setConfigPort(0, import.meta.url, { manager: testManager }), /between 1 and 65535/);
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_CONFIG_DIR;
  delete process.env.DEVSPACE_STATE_DIR;
  delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
}
