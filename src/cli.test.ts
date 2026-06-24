import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = runCli([flag], { DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" }).trim();
  assert.equal(output, packageJson.version);
}

const topLevelHelp = runCli(["--help"]);
assert.equal(runCli([]), topLevelHelp);
assert.match(topLevelHelp, /^usage: devspace \[--version\] \[--help\] <command> \[<args>]$/m);
assert.match(topLevelHelp, /start and connect a local MCP server/);
assert.match(topLevelHelp, /manage persistent DevSpace settings/);
assert.match(topLevelHelp, /Use `devspace config` to show current settings/);
assert.match(topLevelHelp, /Use `devspace --help config` for configuration commands/);

const configHelp = runCli(["--help", "config"]);
assert.match(configHelp, /^usage: devspace config <command> \[<args>]$/m);
assert.match(configHelp, /inspect effective settings/);
assert.match(configHelp, /change persistent server settings/);
assert.match(configHelp, /key\s+Rotate the Owner password and revoke saved OAuth sessions/);
assert.equal(runCli(["-h", "config"]), configHelp);

const root = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));
try {
  const env = {
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
  };

  assert.match(runCli(["config", "host", "127.0.0.1"], env), /Updated local bind host/);
  assert.match(runCli(["config", "port", "8787"], env), /Updated local bind port/);
  assert.match(runCli(["config", "domain", "devspace.example.com/mcp"], env), /public base URL/);

  const defaultShow = runCli(["config"], env);
  assert.ok(defaultShow.includes("bind host: 127.0.0.1"));
  assert.ok(defaultShow.includes("port: 8787"));
  assert.ok(defaultShow.includes("public MCP URL: https://devspace.example.com/mcp"));
  assert.ok(defaultShow.includes("Owner password: (not configured)"));

  const shown = JSON.parse(runCli(["config", "show", "--json"], env)) as {
    host: string;
    port: number;
    publicUrl: string;
    accessKey: string;
  };
  assert.equal(shown.host, "127.0.0.1");
  assert.equal(shown.port, 8787);
  assert.equal(shown.publicUrl, "https://devspace.example.com/mcp");
  assert.equal(shown.accessKey, "(not configured)");

  const keyOutput = runCli(["config", "key"], env);
  assert.match(keyOutput, /Owner password rotated/);
  assert.match(keyOutput, /New Owner password: /);
  assert.match(runCli(["config", "show"], env), /Owner password: .{3}\*+/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runCli(args: string[], overrides: NodeJS.ProcessEnv = {}): string {
  return execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...overrides },
  });
}
