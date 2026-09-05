import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import {
  loadDevspaceFiles,
  setDevspaceConfigValue,
  setDevspaceConfigValues,
} from "./user-config.js";

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "0.0.0.0",
    port: 8787,
    allowedRoots: ["/work"],
    publicBaseUrl: "https://devspace.example.com",
    artifactsEnabled: true,
    subagents: true,
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token",
  }));

  const files = loadDevspaceFiles(env);
  assert.equal(files.migratedLegacyConfig, true);
  assert.equal(files.config.server.host, "0.0.0.0");
  assert.equal(files.config.server.port, 8787);
  assert.deepEqual(files.config.workspaces.allowedRoots, ["/work"]);
  assert.equal(files.config.artifacts.enabled, true);
  assert.equal(files.config.subagents.enabled, true);
  assert.equal(files.config.tools.mode, "codex");
  assert.equal(files.config.ui.enabled, true);
  assert.equal(files.auth.ownerToken, "test-owner-token");
  assert.equal(existsSync(join(configDir, "config.json")), false);
  assert.equal(existsSync(join(configDir, "config.jsonc")), true);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), true);

  const nextLoad = loadDevspaceFiles(env);
  assert.equal(nextLoad.migratedLegacyConfig, false);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    "tools.mode": "claude",
  }));

  const files = loadDevspaceFiles(env);
  assert.equal(files.migratedLegacyConfig, true);
  assert.equal(files.config.tools.mode, "claude");
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    "tools.mode": "codex",
  }));

  const config = loadConfig({
    ...env,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.equal(config.toolMode, "codex");

  const registeredTools: string[] = [];
  getToolSurface(config.toolMode).register({
    server: {
      registerTool(name: string) {
        registeredTools.push(name);
      },
    },
    config,
    workspaces: {},
    processSessions: {},
  } as unknown as ToolRegistrationContext);
  assert.deepEqual(registeredTools, ["apply_patch", "exec_command", "write_stdin"]);
});

await withConfigDirAsync(async (configDir) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 8787,
    allowedRoots: ["/work"],
  }));

  const results = await Promise.all([
    migrateInChildProcess(configDir),
    migrateInChildProcess(configDir),
  ]);
  assert.equal(results.filter((result) => result.migrated).length, 1);
  assert.equal(results.filter((result) => !result.migrated).length, 1);
  assert.equal(existsSync(join(configDir, "config.json")), false);
  assert.equal(existsSync(join(configDir, "config.jsonc")), true);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), true);
  assert.equal(loadDevspaceFiles({ DEVSPACE_CONFIG_DIR: configDir }).config.server.port, 8787);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), `{
    // This comment must survive config updates.
    "configVersion": 1,
    "server": {
      "port": 8787,
    },
  }\n`);

  const files = loadDevspaceFiles(env);
  assert.equal(files.config.server.port, 8787);
  assert.equal(files.config.tools.mode, "codex");

  setDevspaceConfigValue(["server", "publicBaseUrl"], "https://new.example.com", env);
  const updated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(updated, /This comment must survive config updates/);
  assert.equal(loadDevspaceFiles(env).config.server.publicBaseUrl, "https://new.example.com");

  setDevspaceConfigValues([
    { path: ["server", "port"], value: 7676 },
    { path: ["tools", "mode"], value: "claude" },
  ], env);
  const multiUpdated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(multiUpdated, /This comment must survive config updates/);
  assert.equal(loadDevspaceFiles(env).config.server.port, 7676);
  assert.equal(loadDevspaceFiles(env).config.tools.mode, "claude");
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ configVersion: 1 }));
  writeFileSync(join(configDir, "config.json"), "{");
  assert.equal(loadDevspaceFiles(env).config.server.port, 7676);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), "{");
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 8787 }));
  assert.throws(() => loadDevspaceFiles(env), /Unable to read .*config\.jsonc/);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ unknownSetting: true }));
  assert.throws(
    () => loadDevspaceFiles(env),
    /Unsupported legacy configuration keys: unknownSetting/,
  );
  assert.equal(existsSync(join(configDir, "config.json")), true);
  assert.equal(existsSync(join(configDir, "config.jsonc")), false);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), false);
});

withConfigDir((configDir, env) => {
  const legacyPath = join(configDir, "config.json");
  const backupPath = join(configDir, "config.json.v1.0.bak");
  writeFileSync(legacyPath, JSON.stringify({ port: 8787 }));
  writeFileSync(backupPath, JSON.stringify({ port: 7676 }));

  assert.throws(
    () => loadDevspaceFiles(env),
    (error: unknown) => error instanceof Error
      && error.message.includes(`backup already exists at ${backupPath}`)
      && error.message.includes(`Move ${backupPath} out of the way, then run DevSpace again.`),
  );
});

console.log("user config tests passed");

function withConfigDir(
  test: (configDir: string, env: NodeJS.ProcessEnv) => void,
): void {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-user-config-test-"));
  const env = { DEVSPACE_CONFIG_DIR: configDir };
  try {
    test(configDir, env);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function withConfigDirAsync(
  test: (configDir: string) => Promise<void>,
): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-user-config-test-"));
  try {
    await test(configDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function migrateInChildProcess(
  configDir: string,
): Promise<{ migrated: boolean }> {
  const moduleUrl = new URL("./user-config.ts", import.meta.url).href;
  const source = [
    `import { loadDevspaceFiles } from ${JSON.stringify(moduleUrl)};`,
    "const files = loadDevspaceFiles();",
    "process.stdout.write(JSON.stringify({ migrated: files.migratedLegacyConfig }));",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        env: { ...process.env, DEVSPACE_CONFIG_DIR: configDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`migration child exited with ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { migrated: boolean });
    });
  });
}
