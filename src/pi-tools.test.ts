import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-approved-shell-test-"));
const commandsFile = join(root, "approved.json");
const previousCommandsFile = process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;

try {
  await mkdir(join(root, "nested"));
  process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = commandsFile;
  await writeFile(commandsFile, JSON.stringify({
    commands: [{
      alias: "where",
      workspaceRoot: root,
      workingDirectory: "nested",
      command: "pwd",
    }],
  }));

  const allowed = await runShellTool(
    { command: "devspace-approved where" },
    { cwd: root, root },
  );
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.content[0]?.type === "text" ? allowed.content[0].text : "", /nested/);

  const diagnosis = await runShellTool(
    { command: "devspace-runtime diagnose node git" },
    { cwd: root, root },
  );
  assert.equal(diagnosis.isError, undefined);
  const diagnosisText = diagnosis.content[0]?.type === "text" ? diagnosis.content[0].text : "";
  assert.match(diagnosisText, /"accessible": true/);
  assert.match(diagnosisText, /"command": "node"/);

  const smoke = await runShellTool(
    { command: "devspace-runtime smoke" },
    { cwd: root, root },
  );
  assert.equal(smoke.isError, undefined);
  assert.match(smoke.content[0]?.type === "text" ? smoke.content[0].text : "", /"status": "passed"/);

  const costs = await runShellTool(
    { command: "devspace-runtime costs" },
    { cwd: root, root },
  );
  assert.equal(costs.isError, undefined);
  assert.match(costs.content[0]?.type === "text" ? costs.content[0].text : "", /"calls":/);

  const finderEscape = await runShellTool(
    { command: "devspace-runtime finder ../outside" },
    { cwd: root, root },
  );
  assert.equal(finderEscape.isError, true);
  assert.match(
    finderEscape.content[0]?.type === "text" ? finderEscape.content[0].text : "",
    /outside allowed roots/,
  );

  await writeFile(commandsFile, JSON.stringify({
    commands: [{
      alias: "escape",
      workspaceRoot: root,
      workingDirectory: "..",
      command: "pwd",
    }],
  }));
  const denied = await runShellTool(
    { command: "devspace-approved escape" },
    { cwd: root, root },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]?.type === "text" ? denied.content[0].text : "", /outside allowed roots/);
} finally {
  if (previousCommandsFile === undefined) {
    delete process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;
  } else {
    process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = previousCommandsFile;
  }
  await rm(root, { recursive: true, force: true });
}
