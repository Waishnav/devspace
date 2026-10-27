import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

test("shell commands use cmd on Windows, a login shell on macOS, and a POSIX shell on Linux", () => {
  assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
    executable: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", "echo ok"],
  });

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
});

test("Windows process trees are terminated through the tree killer", () => {
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
});

test("POSIX process groups are signalled as a group", () => {
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
});

test("processes without a group are signalled directly", () => {
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
});
