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
import { spawn } from "node:child_process";
import { resolveAllowedPath } from "./roots.js";
import { resolveShellCommand } from "./process-platform.js";

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

/**
 * PR #41: runShellTool with native PowerShell support on Windows.
 *
 * When DEVSPACE_SHELL=powershell (Windows default), commands are executed
 * directly via powershell.exe 鈥?NOT through Git Bash, MSYS, WSL, or bash -c.
 *
 * When DEVSPACE_SHELL=bash or on non-Windows, falls back to pi-coding-agent's
 * createBashTool (which uses Git Bash on Windows).
 *
 * The tool name remains "bash" 鈥?only the execution backend changes.
 */
export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
  const shellMode = process.env.DEVSPACE_SHELL ?? "auto";

  // Determine if we should use PowerShell
  const usePowerShell = process.platform === "win32" &&
    (shellMode === "powershell" || (shellMode === "auto" && !process.env.GIT_BASH_PATH));

  if (usePowerShell) {
    // PR #41: Execute via native PowerShell 鈥?not through Git Bash
    return runPowerShellShell(input.command, context.cwd, timeout);
  }

  // Default: use pi-coding-agent's bash tool (Git Bash on Windows, bash on Unix)
  const tool = createBashTool(context.cwd);
  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}

/**
 * Execute a command via native PowerShell (PR #41).
 *
 * Uses: powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command
 * Does NOT go through Git Bash, MSYS, WSL, or bash -c.
 */
async function runPowerShellShell(command: string, cwd: string, timeoutSeconds: number): Promise<ToolResponse> {
  const shell = resolveShellCommand(command, process.platform, process.env as NodeJS.ProcessEnv);

  return new Promise((resolve) => {
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let resolved = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        // PR #41: Use taskkill /F /T on Windows to kill the entire process tree
        if (process.platform === "win32") {
          try {
            const { spawn: spawnKill } = require("node:child_process");
            spawnKill("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGTERM");
        }
      }
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          content: [{ type: "text", text: `Shell error: ${err.message}` }],
          isError: true,
        });
      }
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      exitCode = code;

      let text = stdout;
      if (stderr) {
        text += (text ? "\n" : "") + stderr;
      }

      if (timedOut) {
        text += (text ? "\n\n" : "") + `Command timed out after ${timeoutSeconds} seconds`;
        resolve({
          content: [{ type: "text", text }],
          isError: true,
        });
      } else if (exitCode !== 0 && exitCode !== null) {
        text += (text ? "\n\n" : "") + `Command exited with code ${exitCode}`;
        resolve({
          content: [{ type: "text", text }],
          isError: true,
        });
      } else {
        resolve({
          content: [{ type: "text", text: text || "(no output)" }],
        });
      }
    });
  });
}