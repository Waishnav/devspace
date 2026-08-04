import { existsSync } from "node:fs";
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

export interface ShellResolutionRuntime {
  exists(path: string): boolean;
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

const defaultShellResolutionRuntime: ShellResolutionRuntime = {
  exists: existsSync,
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
export function resolveBashToolShellMode(
  environment: NodeJS.ProcessEnv = process.env,
): ShellMode {
  const configured = environment.DEVSPACE_SHELL;
  if (configured === undefined || configured === "auto" || configured === "bash") return "bash";
  if (configured === "powershell" || configured === "cmd") return configured;
  throw new Error(`Invalid DEVSPACE_SHELL: ${configured}`);
}

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  shellMode?: ShellMode,
  runtime: ShellResolutionRuntime = defaultShellResolutionRuntime,
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
      const bashPath = findBashOnWindows(environment, runtime);
      if (bashPath) return { executable: bashPath, args: ["-lc", command] };
      const error = new Error(
        "Git Bash is required for the DevSpace bash tool on Windows. "
          + "Install Git for Windows or set GIT_BASH_PATH to bash.exe.",
      );
      (error as NodeJS.ErrnoException).code = "git_bash_not_found";
      throw error;
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
function findBashOnWindows(
  environment: NodeJS.ProcessEnv,
  runtime: ShellResolutionRuntime,
): string | null {
  const candidates = [
    environment.GIT_BASH_PATH,
    environment.BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = candidate.trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (runtime.exists(normalized)) return normalized;
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
