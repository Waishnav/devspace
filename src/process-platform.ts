import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import type { ShellMode } from "./config.js";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

/**
 * PowerShell executable and fixed arguments.
 * PR #41: Windows native PowerShell — must NOT route through Git Bash, MSYS, WSL, or bash -c.
 *
 * Security note (PR #41): raw Windows paths should not be used as the right-hand side
 * of -match (they contain backslashes which are regex metacharacters). Use .Contains(),
 * -like, or [regex]::Escape() for literal path matching. Genuine regex is still allowed.
 */
const POWERSHELL_EXECUTABLE = "powershell.exe";
const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-Command",
];

/**
 * Resolve a shell command for the given platform and environment.
 *
 * PR #41: Supports DEVSPACE_SHELL=auto|bash|powershell|cmd.
 * Windows default is "powershell" (not cmd.exe) when DEVSPACE_SHELL is auto or unset.
 *
 * Modes:
 *  - powershell: powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <command>
 *  - cmd: cmd.exe /d /s /c <command>
 *  - bash: bash -lc <command> (or bash -c for POSIX shells)
 *  - auto: platform-dependent default (powershell on Windows, sh on others)
 */
export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  shellMode?: ShellMode,
): ShellCommand {
  const mode = shellMode ?? (environment.DEVSPACE_SHELL as ShellMode | undefined) ?? "auto";

  if (platform === "win32") {
    // Explicit mode resolution
    if (mode === "powershell") {
      return {
        executable: POWERSHELL_EXECUTABLE,
        args: [...POWERSHELL_ARGS, command],
      };
    }
    if (mode === "cmd") {
      return {
        executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
        args: ["/d", "/s", "/c", command],
      };
    }
    if (mode === "bash") {
      // Find bash without going through MSYS/Git Bash wrapper
      const bashPath = environment.BASH ?? findBashOnWindows();
      if (bashPath) {
        return { executable: bashPath, args: ["-lc", command] };
      }
      // Fall back to PowerShell if bash not found
      return {
        executable: POWERSHELL_EXECUTABLE,
        args: [...POWERSHELL_ARGS, command],
      };
    }
    // auto on Windows: default to PowerShell
    return {
      executable: POWERSHELL_EXECUTABLE,
      args: [...POWERSHELL_ARGS, command],
    };
  }

  // Non-Windows: auto resolves to user's shell or /bin/sh
  if (mode === "powershell") {
    // On non-Windows, try pwsh if available
    return { executable: "pwsh", args: ["-NoLogo", "-NoProfile", "-Command", command] };
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

/**
 * Find bash.exe on Windows without using MSYS/Git Bash wrapper.
 * Looks in typical Git for Windows install locations.
 */
function findBashOnWindows(): string | null {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    try {
      spawnSync("cmd.exe", ["/c", "if", "exist", c, "echo", "found"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      // If the file exists, use it directly (not through MSYS wrapper)
      return c;
    } catch {
      continue;
    }
  }
  return null;
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
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
