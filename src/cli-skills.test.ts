import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-skills-test-"));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

try {
  const help = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.match(help, /devspace skills install/);
  assert.match(help, /devspace skills list -g/);
  assert.match(help, /devspace skills remove -g/);
  assert.match(help, /install expects the target path to point at one standard skill directory with a SKILL\.md file/);

  for (const flag of ["-v", "--version"]) {
    const version = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", flag], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: root },
    }).trim();
    assert.equal(version, packageVersion);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
