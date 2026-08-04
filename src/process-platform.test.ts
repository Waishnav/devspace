import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import {
  resolveBashToolShellMode,
  resolveShellCommand,
  terminateProcessTree,
} from "./process-platform.js";
import { runResolvedShell, runShellTool } from "./pi-tools.js";

// PR #41: Windows default is now PowerShell (not cmd.exe)
assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "powershell.exe",
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "echo ok"],
});

// Explicit cmd mode still works
assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe", DEVSPACE_SHELL: "cmd" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

// Explicit powershell mode remains available.
assert.deepEqual(resolveShellCommand("echo ok", "win32", { DEVSPACE_SHELL: "powershell" }), {
  executable: "powershell.exe",
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "echo ok"],
});

// The model-facing tool is named Bash, so unset/auto/bash must preserve POSIX parsing.
assert.equal(resolveBashToolShellMode({}), "bash");
assert.equal(resolveBashToolShellMode({ DEVSPACE_SHELL: "auto" }), "bash");
assert.equal(resolveBashToolShellMode({ DEVSPACE_SHELL: "bash" }), "bash");
assert.equal(resolveBashToolShellMode({ DEVSPACE_SHELL: "powershell" }), "powershell");
assert.equal(resolveBashToolShellMode({ DEVSPACE_SHELL: "cmd" }), "cmd");

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
assert.deepEqual(resolveShellCommand(
  "printf ok && git rev-parse '@{upstream}'",
  "win32",
  { GIT_BASH_PATH: gitBash },
  "bash",
  { exists: (candidate) => candidate === gitBash },
), {
  executable: gitBash,
  args: ["-lc", "printf ok && git rev-parse '@{upstream}'"],
});

assert.throws(
  () => resolveShellCommand("echo ok", "win32", {}, "bash", { exists: () => false }),
  (error: unknown) => (
    error instanceof Error
    && (error as NodeJS.ErrnoException).code === "git_bash_not_found"
  ),
);

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);

const hungChild = new EventEmitter() as EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
};
hungChild.pid = 45;
hungChild.stdout = new PassThrough();
hungChild.stderr = new PassThrough();
const hungChildKills: Array<NodeJS.Signals | undefined> = [];
hungChild.kill = (signal) => (hungChildKills.push(signal), true);
const timeoutTreeCalls: Array<{ signal: NodeJS.Signals; detached: boolean }> = [];
const boundedTimeout = await runResolvedShell(
  "echo never-closes",
  process.cwd(),
  0.001,
  "powershell",
  {
    platform: "win32",
    environment: {},
    spawnImpl: (() => hungChild) as unknown as typeof spawn,
    terminateTree: (_child, signal, detached) => {
      timeoutTreeCalls.push({ signal, detached });
    },
    terminationGraceMs: 5,
  },
);
assert.equal(boundedTimeout.isError, true);
assert.match(
  boundedTimeout.content[0]?.type === "text" ? boundedTimeout.content[0].text : "",
  /timed out.*did not close/,
);
assert.deepEqual(timeoutTreeCalls, [{ signal: "SIGTERM", detached: false }]);
assert.deepEqual(hungChildKills, ["SIGKILL"]);

if (process.platform === "win32") {
  const previousShell = process.env.DEVSPACE_SHELL;
  const previousGitBash = process.env.GIT_BASH_PATH;
  try {
    process.env.DEVSPACE_SHELL = "auto";
    process.env.GIT_BASH_PATH = gitBash;
    const response = await runShellTool({
      command: "printf 'left' && printf '%s' '@{upstream}'",
      timeout: 10,
    }, {
      cwd: process.cwd(),
      root: process.cwd(),
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.content[0]?.type, "text");
    assert.equal(response.content[0]?.type === "text" ? response.content[0].text : "", "left@{upstream}");
  } finally {
    if (previousShell === undefined) delete process.env.DEVSPACE_SHELL;
    else process.env.DEVSPACE_SHELL = previousShell;
    if (previousGitBash === undefined) delete process.env.GIT_BASH_PATH;
    else process.env.GIT_BASH_PATH = previousGitBash;
  }
}
