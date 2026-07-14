import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const root = mkdtempSync(join(tmpdir(), "devspace-pi-tools-test-"));
writeFileSync(join(root, "marker.txt"), "marker\n");

if (process.platform === "win32") {
  const simple = await runShellTool(
    { command: "Write-Output 'native-powershell-ok'" },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(simple.isError, undefined);
  assert.match(simple.content[0]?.type === "text" ? simple.content[0].text : "", /native-powershell-ok/);

  const blockedMatch = await runShellTool(
    { command: "$_.Path -match 'C:\\Users\\Yuri\\Documents'" },
    { cwd: root, root, shell: "powershell" },
  );
  const blockedMatchText = blockedMatch.content[0]?.type === "text" ? blockedMatch.content[0].text : "";
  assert.equal(blockedMatch.isError, true);
  assert.match(blockedMatchText, /Blocked fragile PowerShell command/);
  assert.match(blockedMatchText, /\.Contains/);
  assert.match(blockedMatchText, /-like/);
  assert.match(blockedMatchText, /\[regex\]::Escape/);

  const blockedVariableMatch = await runShellTool(
    {
      command: "$path = 'pydoll-mcp-server\\profiles\\chatgpt-linkedin-check'; $_.CommandLine -match $path",
    },
    { cwd: root, root, shell: "powershell" },
  );
  const blockedVariableMatchText = blockedVariableMatch.content[0]?.type === "text"
    ? blockedVariableMatch.content[0].text
    : "";
  assert.equal(blockedVariableMatch.isError, true);
  assert.match(blockedVariableMatchText, /pydoll-mcp-server\\profiles\\chatgpt-linkedin-check/);
  assert.match(blockedVariableMatchText, /\[regex\]::Escape/);

  const regexDigitMatch = await runShellTool(
    { command: "'chrome.exe --remote-debugging-port=9224' -match 'remote-debugging-port=\\d+'" },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(regexDigitMatch.isError, undefined);
  assert.match(regexDigitMatch.content[0]?.type === "text" ? regexDigitMatch.content[0].text : "", /True/);

  const regexDigitVariableMatch = await runShellTool(
    {
      command: "$pattern = 'remote-debugging-port=\\d+'; 'chrome.exe --remote-debugging-port=9224' -match $pattern",
    },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(regexDigitVariableMatch.isError, undefined);
  assert.match(
    regexDigitVariableMatch.content[0]?.type === "text" ? regexDigitVariableMatch.content[0].text : "",
    /True/,
  );

  const contains = await runShellTool(
    { command: "'C:\\Users\\Yuri\\Documents'.Contains('C:\\Users\\Yuri')" },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(contains.isError, undefined);
  assert.match(contains.content[0]?.type === "text" ? contains.content[0].text : "", /True/);

  const escapedMatch = await runShellTool(
    {
      command: "$pattern = [regex]::Escape('C:\\Users\\Yuri'); 'C:\\Users\\Yuri\\Documents' -match $pattern",
    },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(escapedMatch.isError, undefined);
  assert.match(escapedMatch.content[0]?.type === "text" ? escapedMatch.content[0].text : "", /True/);

  const pipeline = await runShellTool(
    {
      command: "@('alpha','beta') | Where-Object { $_ -like 'b*' } | ForEach-Object { \"item=$_\" }",
    },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(pipeline.isError, undefined);
  assert.match(pipeline.content[0]?.type === "text" ? pipeline.content[0].text : "", /item=beta/);

  const cwd = await runShellTool(
    { command: "(Get-Location).Path" },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(cwd.isError, undefined);
  assert.equal(cwd.content[0]?.type === "text" ? cwd.content[0].text : "", root);

  const failed = await runShellTool(
    { command: "Write-Error 'expected failure'; exit 9" },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]?.type === "text" ? failed.content[0].text : "", /Command exited with code 9/);

  const timedOut = await runShellTool(
    { command: "Start-Sleep -Seconds 5", timeout: 1 },
    { cwd: root, root, shell: "powershell" },
  );
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0]?.type === "text" ? timedOut.content[0].text : "", /timed out after 1 seconds/);

  const cmd = await runShellTool(
    { command: "echo native-cmd-ok" },
    { cwd: root, root, shell: "cmd" },
  );
  assert.equal(cmd.isError, undefined);
  assert.match(cmd.content[0]?.type === "text" ? cmd.content[0].text : "", /native-cmd-ok/);
} else {
  const bash = await runShellTool(
    { command: "printf 'native-bash-ok\\n'" },
    { cwd: root, root, shell: "bash" },
  );
  assert.equal(bash.isError, undefined);
  assert.match(bash.content[0]?.type === "text" ? bash.content[0].text : "", /native-bash-ok/);
}
