import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";

const require = createRequire(import.meta.url);
const {
  SUPPORTED_NODE_RANGE,
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
} = require("../scripts/node-version.cjs") as {
  SUPPORTED_NODE_RANGE: string;
  formatUnsupportedNodeMessage(version?: string): string;
  isSupportedNodeVersion(version: string): boolean;
};
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin: { devspace: string };
  engines: { node: string };
  files: string[];
  scripts: { preinstall: string };
  version: string;
};
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: { "": { bin: { devspace: string } } };
};

assert.equal(packageJson.bin.devspace, "scripts/devspace.cjs");
assert.equal(packageLock.packages[""].bin.devspace, packageJson.bin.devspace);
assert.equal(packageJson.engines.node, SUPPORTED_NODE_RANGE);
assert.equal(packageJson.scripts.preinstall, "node scripts/check-node-version.cjs");
assert.ok(packageJson.files.includes("scripts"));
assert.equal(isSupportedNodeVersion("18.19.1"), false);
assert.equal(isSupportedNodeVersion("20.20.0"), false);
assert.equal(isSupportedNodeVersion("22.18.0"), false);
assert.equal(isSupportedNodeVersion("22.19.0"), true);
assert.equal(isSupportedNodeVersion("v22.19.0"), true);
assert.equal(isSupportedNodeVersion("23.0.0"), true);
assert.equal(isSupportedNodeVersion("26.9.0"), true);
assert.equal(isSupportedNodeVersion("27.0.0"), false);
assert.equal(isSupportedNodeVersion("invalid"), false);
assert.match(formatUnsupportedNodeMessage("v18.19.1"), /requires Node\.js >=22\.19 <27/);
assert.match(formatUnsupportedNodeMessage("v18.19.1"), /Current Node\.js: v18\.19\.1/);
assert.match(formatUnsupportedNodeMessage("18.19.1"), /Current Node\.js: v18\.19\.1/);

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
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
