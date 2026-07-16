import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WaitableProcess extends KillableProcess {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

export interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  isGroupAlive(pid: number): boolean;
  killWindowsTree(pid: number, force: boolean): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  isGroupAlive: (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  killWindowsTree: (pid, force) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid, signal === "SIGKILL")) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}

export async function terminateProcessTreeGracefully(
  child: WaitableProcess,
  detached: boolean,
  graceMs = 1_000,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): Promise<void> {
  const tracksGroup = runtime.platform !== "win32" && detached && child.pid !== undefined;
  if (!tracksGroup && child.exitCode !== null && child.exitCode !== undefined) return;
  if (!tracksGroup && child.signalCode) return;

  terminateProcessTree(child, "SIGTERM", detached, runtime);
  if (await waitForProcessTreeExit(child, detached, graceMs, runtime)) return;
  terminateProcessTree(child, "SIGKILL", detached, runtime);
  await waitForProcessTreeExit(child, detached, graceMs, runtime);
}

function waitForProcessTreeExit(
  child: WaitableProcess,
  detached: boolean,
  timeoutMs: number,
  runtime: ProcessTreeRuntime,
): Promise<boolean> {
  if (runtime.platform !== "win32" && detached && child.pid !== undefined) {
    if (!runtime.isGroupAlive(child.pid)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (!runtime.isGroupAlive(child.pid as number)) {
          resolve(true);
        } else if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(poll, Math.min(25, timeoutMs));
        }
      };
      setTimeout(poll, Math.min(25, timeoutMs));
    });
  }
  return waitForProcessClose(child, timeoutMs);
}

function waitForProcessClose(child: WaitableProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  if (child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}
