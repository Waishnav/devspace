import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyWorkspacePatch, extractPatchPaths, gitPush } from "./workspace-operations.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-ops-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const patch = [
    "diff --git a/README.md b/README.md",
    "index ce01362..94954ab 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    " hello",
    "+world",
    "",
  ].join("\n");
  assert.deepEqual(extractPatchPaths(patch), ["README.md"]);
  const result = await applyWorkspacePatch({ patch }, { root });
  assert.deepEqual(result.files, ["README.md"]);
  assert.equal(normalizeNewlines(await readFile(join(root, "README.md"), "utf8")), "hello\nworld\n");

  const escapingPatch = [
    "diff --git a/../escape.txt b/../escape.txt",
    "--- a/../escape.txt",
    "+++ b/../escape.txt",
    "@@ -0,0 +1 @@",
    "+bad",
    "",
  ].join("\n");
  await assert.rejects(
    () => applyWorkspacePatch({ patch: escapingPatch }, { root }),
    /Path is outside allowed roots/,
  );

  await assert.rejects(
    () => gitPush({ remote: "--upload-pack=bad" }, { root }),
    /Invalid git remote/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
