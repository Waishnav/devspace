import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDevspaceFiles } from "./user-config.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

test("config set tells users to restart the running server", () => {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));

  try {
    const env = { ...process.env, ...writeTestDevspaceConfig(configDir) };

    const stdout = execFileSync(
      "node",
      ["--import", "tsx", "src/cli.ts", "config", "set", "publicBaseUrl", "https://example.com"],
      { encoding: "utf8", env },
    );

    assert.match(stdout, /Updated .*config\.jsonc/);
    assert.match(stdout, /Restart `devspace serve` to apply this change/);
    assert.equal(loadDevspaceFiles(env).config.server.publicBaseUrl, "https://example.com");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
