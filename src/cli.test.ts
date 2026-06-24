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
assert.match(configHelp, /^usage: devspace config \[<command> \[<args>\]\]$/m);
assert.match(configHelp, /\(no command\)\s+Print effective settings as JSON/);
assert.match(configHelp, /domain <domain>\s+Set the public domain; MCP uses \/mcp automatically/);
assert.match(configHelp, /key <key>\s+Set the Owner password and revoke saved OAuth sessions/);
assert.equal(runCli(["-h", "config"]), configHelp);

const root = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));
try {
  const env = {
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
  };

  assert.match(runCli(["config", "host", "127.0.0.1"], env), /Updated local bind host/);
  assert.match(runCli(["config", "port", "8787"], env), /Updated local bind port/);
  assert.match(runCli(["config", "domain", "devspace.example.com"], env), /public domain/);

  const shown = JSON.parse(runCli(["config"], env)) as {
    host: string;
    port: number;
    publicBaseUrl: string;
    publicUrl: string;
    accessKey: string;
  };
  assert.equal(shown.host, "127.0.0.1");
  assert.equal(shown.port, 8787);
  assert.equal(shown.publicBaseUrl, "https://devspace.example.com");
  assert.equal(shown.publicUrl, "https://devspace.example.com/mcp");
  assert.equal(shown.accessKey, "(not configured)");

  const newOwnerPassword = "cli-owner-password-for-test";
  const keyOutput = runCli(["config", "key", newOwnerPassword], env);
  assert.match(keyOutput, /Owner password updated/);
  assert.ok(!keyOutput.includes(newOwnerPassword));
  const updated = JSON.parse(runCli(["config"], env)) as { accessKey: string };
  assert.match(updated.accessKey, /^.{3}\*+/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runCli(args: string[], overrides: NodeJS.ProcessEnv = {}): string {
  return execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...overrides },
  });
}
