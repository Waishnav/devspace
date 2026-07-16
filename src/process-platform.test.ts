import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  resolveShellCommand,
  terminateProcessTree,
  terminateProcessTreeGracefully,
} from "./process-platform.js";

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

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    isGroupAlive: () => false,
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
    isGroupAlive: () => false,
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
    isGroupAlive: () => false,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);

class ClosingProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close"));
    return true;
  }
}

const closingProcess = new ClosingProcess();
await terminateProcessTreeGracefully(closingProcess, false, 10);
assert.deepEqual(closingProcess.signals, ["SIGTERM"]);

{
  const forceCalls: boolean[] = [];
  const process = new ClosingProcess();
  process.pid = 45;
  process.kill = () => true;
  await terminateProcessTreeGracefully(process, false, 1, {
    platform: "win32",
    killGroup: () => undefined,
    isGroupAlive: () => false,
    killWindowsTree: (_pid, force) => (forceCalls.push(force), true),
  });
  assert.deepEqual(forceCalls, [false, true]);
}

{
  const groupSignals: NodeJS.Signals[] = [];
  let groupAlive = true;
  const process = new ClosingProcess();
  process.pid = 46;
  await terminateProcessTreeGracefully(process, true, 1, {
    platform: "linux",
    killGroup: (_pid, signal) => {
      groupSignals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => process.emit("close"));
      if (signal === "SIGKILL") groupAlive = false;
    },
    isGroupAlive: () => groupAlive,
    killWindowsTree: () => false,
  });
  assert.deepEqual(groupSignals, ["SIGTERM", "SIGKILL"]);
}
