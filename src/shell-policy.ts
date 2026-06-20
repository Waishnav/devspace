import type { ShellMode } from "./config.js";

export interface ShellPolicyDecision {
  allowed: boolean;
  mode: ShellMode;
  reason?: string;
}

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "df",
  "du",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
]);

const SHELL_CONTROL_PATTERNS = [/&&/, /\|\|/, /;/, /\|/, />/, /</, /`/, /\$\(/];
const DESTRUCTIVE_FIND_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

export function validateShellCommand(mode: ShellMode, command: string): ShellPolicyDecision {
  const trimmed = command.trim();

  if (mode === "off") {
    return deny(mode, "Shell execution is disabled by DEVSPACE_SHELL_MODE=off.");
  }

  if (!trimmed) {
    return deny(mode, "Shell command is empty.");
  }

  if (mode === "full") {
    return allow(mode);
  }

  if (hasShellControlOperator(trimmed)) {
    return deny(
      mode,
      "DEVSPACE_SHELL_MODE=read-only allows a single inspection command without pipes, redirects, or shell control operators.",
    );
  }

  const words = trimmed.split(/\s+/);
  const commandName = basename(words[0] ?? "");
  if (!READ_ONLY_COMMANDS.has(commandName)) {
    return deny(
      mode,
      `DEVSPACE_SHELL_MODE=read-only blocked '${commandName}'. Allowed commands: ${Array.from(READ_ONLY_COMMANDS).join(", ")}.`,
    );
  }

  if (commandName === "git") {
    return validateGitCommand(words, mode);
  }

  if (commandName === "find") {
    return validateFindCommand(words, mode);
  }

  return allow(mode);
}

function validateGitCommand(words: string[], mode: ShellMode): ShellPolicyDecision {
  const subcommand = words[1];
  if (!subcommand) return allow(mode);

  if (subcommand.startsWith("-")) {
    return deny(mode, "DEVSPACE_SHELL_MODE=read-only only allows direct read-only git subcommands.");
  }

  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return deny(
      mode,
      `DEVSPACE_SHELL_MODE=read-only blocked 'git ${subcommand}'. Allowed git subcommands: ${Array.from(READ_ONLY_GIT_SUBCOMMANDS).join(", ")}.`,
    );
  }

  return allow(mode);
}

function validateFindCommand(words: string[], mode: ShellMode): ShellPolicyDecision {
  const destructiveFlag = words.find((word) => DESTRUCTIVE_FIND_FLAGS.has(word));
  if (destructiveFlag) {
    return deny(mode, `DEVSPACE_SHELL_MODE=read-only blocked find flag '${destructiveFlag}'.`);
  }

  return allow(mode);
}

function hasShellControlOperator(command: string): boolean {
  return SHELL_CONTROL_PATTERNS.some((pattern) => pattern.test(command));
}

function basename(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase();
}

function allow(mode: ShellMode): ShellPolicyDecision {
  return { allowed: true, mode };
}

function deny(mode: ShellMode, reason: string): ShellPolicyDecision {
  return { allowed: false, mode, reason };
}
