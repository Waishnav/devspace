import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { ShellMode } from "./config.js";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  shell?: ShellMode;
}

export type ResolvedShellMode = "bash" | "powershell" | "cmd";

export interface ResolvedShellCommand {
  mode: ResolvedShellMode;
  command: string;
  args: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

function resolveShellMode(mode: ShellMode | undefined): ResolvedShellMode {
  if (mode && mode !== "auto") return mode;
  return process.platform === "win32" ? "powershell" : "bash";
}

export function resolveShellCommand(mode: ShellMode | undefined): ResolvedShellCommand {
  const resolvedMode = resolveShellMode(mode);

  if (resolvedMode === "powershell") {
    return process.platform === "win32"
      ? {
          mode: "powershell",
          command: "powershell.exe",
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
        }
      : {
          mode: "powershell",
          command: "pwsh",
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        };
  }

  if (resolvedMode === "cmd") {
    return { mode: "cmd", command: "cmd.exe", args: ["/d", "/s", "/c"] };
  }

  return { mode: "bash", command: "bash", args: ["-c"] };
}

function killChildProcess(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    }).unref();
    return;
  }

  child.kill("SIGTERM");
}

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });

  return result.status === 0;
}

export function resolveRunnableShellCommand(mode: ShellMode | undefined): ResolvedShellCommand {
  const shellCommand = resolveShellCommand(mode);
  if (
    shellCommand.mode === "powershell" &&
    process.platform === "win32" &&
    !commandExists(shellCommand.command) &&
    commandExists("pwsh")
  ) {
    return {
      mode: "powershell",
      command: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  return shellCommand;
}

function findUnsafePowerShellRegexLiteral(command: string): string | undefined {
  if (/\[regex\]::Escape\s*\(/i.test(command)) return undefined;

  const unsafeAssignments = collectUnsafePowerShellRegexVariableAssignments(command);
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" || char === "\"") {
      index = skipPowerShellQuotedLiteral(command, index);
      continue;
    }

    if (!isPowerShellMatchOperatorAt(command, index)) continue;
    const operandStart = skipWhitespace(command, index + "-match".length);
    const operand = command[operandStart];

    if (operand === "'" || operand === "\"") {
      const literal = readPowerShellQuotedLiteral(command, operandStart);
      if (literal && looksLikeWindowsPathRegexLiteral(literal.value)) return literal.value;
      index = literal?.end ?? operandStart;
      continue;
    }

    if (operand === "$") {
      const variable = readPowerShellVariableName(command, operandStart + 1);
      if (variable && unsafeAssignments.has(variable.name)) return unsafeAssignments.get(variable.name);
      index = variable?.end ?? operandStart;
    }
  }

  return undefined;
}

function collectUnsafePowerShellRegexVariableAssignments(command: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" || char === "\"") {
      index = skipPowerShellQuotedLiteral(command, index);
      continue;
    }

    if (char !== "$" || !isTokenBoundary(command[index - 1])) continue;
    const variable = readPowerShellVariableName(command, index + 1);
    if (!variable) continue;

    let next = skipWhitespace(command, variable.end);
    if (command[next] !== "=") {
      index = variable.end;
      continue;
    }

    next = skipWhitespace(command, next + 1);
    if (command[next] !== "'" && command[next] !== "\"") {
      index = next;
      continue;
    }

    const literal = readPowerShellQuotedLiteral(command, next);
    if (literal && looksLikeWindowsPathRegexLiteral(literal.value)) {
      assignments.set(variable.name, literal.value);
    }
    index = literal?.end ?? next;
  }

  return assignments;
}

function looksLikeWindowsPathRegexLiteral(literal: string): boolean {
  if (/[A-Za-z]:\\/.test(literal)) return true;
  if (/^\\\\[^\\]+\\[^\\]+/.test(literal)) return true;
  if (/\\(?:users|appdata|profiles?|documents|downloads|desktop|program files|programdata|windows|system32|node_modules)(?:\\|$)/i.test(literal)) {
    return true;
  }
  if (/\\[pP](?!\{)/.test(literal)) return true;
  if (/\\[uU](?![0-9a-fA-F]{4})/.test(literal)) return true;
  return /\\[A-Za-z]{2,}(?:\\|$)/.test(literal);
}

interface PowerShellQuotedLiteral {
  value: string;
  end: number;
}

interface PowerShellVariableName {
  name: string;
  end: number;
}

function readPowerShellQuotedLiteral(command: string, start: number): PowerShellQuotedLiteral | undefined {
  const quote = command[start];
  if (quote !== "'" && quote !== "\"") return undefined;

  let value = "";
  for (let index = start + 1; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'" && char === "'" && command[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }

    if (quote === "\"" && char === "`" && index + 1 < command.length) {
      value += command[index + 1];
      index += 1;
      continue;
    }

    if (char === quote) return { value, end: index };
    value += char;
  }

  return undefined;
}

function skipPowerShellQuotedLiteral(command: string, start: number): number {
  return readPowerShellQuotedLiteral(command, start)?.end ?? command.length - 1;
}

function readPowerShellVariableName(command: string, start: number): PowerShellVariableName | undefined {
  const first = command[start];
  if (!first || !/[A-Za-z_]/.test(first)) return undefined;

  let end = start + 1;
  while (end < command.length && /[A-Za-z0-9_]/.test(command[end])) end += 1;
  return { name: command.slice(start, end), end };
}

function isPowerShellMatchOperatorAt(command: string, index: number): boolean {
  if (command.slice(index, index + "-match".length).toLowerCase() !== "-match") return false;
  return isTokenBoundary(command[index - 1]) && isTokenBoundary(command[index + "-match".length]);
}

function isTokenBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char) || "|;&({[,".includes(char);
}

function skipWhitespace(command: string, start: number): number {
  let index = start;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  return index;
}

function unsafePowerShellRegexLiteralMessage(literal: string): string {
  return [
    "Blocked fragile PowerShell command before execution.",
    "",
    "PowerShell -match treats the right-hand string as regex, not a literal substring.",
    `The pattern contains a backslash: ${literal}`,
    "Windows path fragments such as \\p or \\U can break regex parsing or match the wrong text.",
    "",
    "Use one of these safer forms for literal matching:",
    '  $_.CommandLine.Contains("literal\\path")',
    '  $_.CommandLine -like "*literal*path*"',
    '  $pattern = [regex]::Escape("literal\\path"); $_.CommandLine -match $pattern',
  ].join("\n");
}

async function runNativeShell(
  input: BashToolInput,
  context: ToolContext,
  timeout: number,
): Promise<ToolResponse> {
  const shellCommand = resolveRunnableShellCommand(context.shell);
  const unsafeLiteral = shellCommand.mode === "powershell"
    ? findUnsafePowerShellRegexLiteral(input.command)
    : undefined;

  if (unsafeLiteral !== undefined) {
    return {
      content: [{ type: "text", text: unsafePowerShellRegexLiteralMessage(unsafeLiteral) }],
      isError: true,
    };
  }

  return new Promise((resolve) => {
    const output: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const child = spawn(shellCommand.command, [...shellCommand.args, input.command], {
      cwd: context.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          killChildProcess(child);
        }, timeout * 1000)
      : undefined;

    const finish = (response: ToolResponse) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(response);
    };

    child.stdout.on("data", (data: Buffer) => output.push(data));
    child.stderr.on("data", (data: Buffer) => output.push(data));

    child.on("error", (error) => {
      finish({ content: formatToolError(error), isError: true });
    });

    child.on("close", (exitCode) => {
      const text = Buffer.concat(output).toString("utf8").trimEnd();
      const outputText = text || "(no output)";
      if (timedOut) {
        finish({
          content: [{ type: "text", text: `${text ? `${text}\n\n` : ""}Command timed out after ${timeout} seconds` }],
          isError: true,
        });
        return;
      }

      if (exitCode !== 0 && exitCode !== null) {
        finish({
          content: [{ type: "text", text: `${outputText}\n\nCommand exited with code ${exitCode}` }],
          isError: true,
        });
        return;
      }

      finish({ content: [{ type: "text", text: outputText }] });
    });
  });
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
  const shellMode = resolveShellMode(context.shell);

  if (shellMode !== "bash") {
    return runNativeShell(input, context, timeout);
  }

  const tool = createBashTool(context.cwd);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
