import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-skills-test-"));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

try {
  const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(help, /devspace skills install/);
  assert.match(help, /devspace skills list -g/);
  assert.match(help, /devspace skills remove -g/);
  assert.match(help, /install expects the target path to point at one standard skill directory with a SKILL\.md file/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
