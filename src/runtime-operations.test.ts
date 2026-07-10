import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  diagnoseRuntime,
  finderOpenArguments,
  runCompatibilitySmoke,
} from "./runtime-operations.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-runtime-operations-"));
try {
  await writeFile(join(root, "AGENTS.md"), "Test instructions.\n", "utf8");
  await writeFile(join(root, "package.json"), '{"name":"runtime-test"}\n', "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const diagnostics = await diagnoseRuntime({
    workspaceRoot: root,
    commands: ["git", "node", "definitely-missing-command"],
    checkGitHubAuth: false,
  });
  assert.equal(diagnostics.workspace.accessible, true);
  assert.equal(diagnostics.workspace.gitRepository, true);
  assert.equal(diagnostics.executables.find((entry) => entry.command === "git")?.found, true);
  assert.equal(
    diagnostics.executables.find((entry) => entry.command === "definitely-missing-command")?.found,
    false,
  );
  assert.equal(diagnostics.githubAuthentication, "not_checked");

  const smoke = await runCompatibilitySmoke(root);
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.summary.failed, 0);
  assert.equal(smoke.steps.find((step) => step.name === "workspace")?.status, "passed");
  assert.equal(smoke.steps.find((step) => step.name === "git")?.status, "passed");

  assert.deepEqual(finderOpenArguments("/tmp/file.txt", "file", "darwin"), ["-R", "/tmp/file.txt"]);
  assert.deepEqual(finderOpenArguments("/tmp/folder", "directory", "darwin"), ["/tmp/folder"]);
  assert.equal(finderOpenArguments("C:\\temp", "directory", "win32"), undefined);
} finally {
  await rm(root, { recursive: true, force: true });
}
