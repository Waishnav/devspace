import {
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
import {
  resolveBashToolShellMode,
  resolveShellCommand,
  terminateProcessTree,
} from "./process-platform.js";
import type { ShellMode } from "./config.js";

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
 * Execute the model-facing Bash tool with deterministic shell semantics.
 *
 * Unset/auto/bash uses Git Bash on Windows so POSIX syntax is never parsed by
 * PowerShell. Users can still explicitly select powershell or cmd. A requested
 * Bash executable must exist; shell resolution fails closed instead of changing
 * the command language.
 */
export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
  const shellMode = resolveBashToolShellMode(process.env);
  try {
    return await runResolvedShell(input.command, context.cwd, timeout, shellMode);
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function runResolvedShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  shellMode: ShellMode,
  {
    platform = process.platform,
    environment = process.env,
    spawnImpl = spawn,
    terminateTree = terminateProcessTree,
    terminationGraceMs = 5_000,
  }: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    spawnImpl?: typeof spawn;
    terminateTree?: typeof terminateProcessTree;
    terminationGraceMs?: number;
  } = {},
): Promise<ToolResponse> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TypeError("shell timeoutSeconds must be positive");
  }
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError("shell terminationGraceMs must be a positive integer");
  }
  const shell = resolveShellCommand(command, platform, environment, shellMode);
  const detached = platform !== "win32";

  return new Promise((resolve) => {
    const child = spawnImpl(shell.executable, shell.args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;
    let terminationTimer: ReturnType<typeof setTimeout> | null = null;

    const outputText = (): string => {
      let text = stdout;
      if (stderr) text += (text ? "\n" : "") + stderr;
      return text;
    };
    const finish = (response: ToolResponse): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (terminationTimer !== null) clearTimeout(terminationTimer);
      resolve(response);
    };
    const timeoutResponse = (cleanupTimedOut = false): ToolResponse => {
      let text = outputText();
      text += (text ? "\n\n" : "") + `Command timed out after ${timeoutSeconds} seconds`;
      if (cleanupTimedOut) text += `; process tree did not close within ${terminationGraceMs}ms`;
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      timedOut = true;
      terminationTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish(timeoutResponse(true));
      }, terminationGraceMs);
      try {
        terminateTree(child, "SIGTERM", detached);
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (err) => {
      if (timedOut) {
        finish(timeoutResponse());
        return;
      }
      finish({
        content: [{ type: "text", text: `Shell error: ${err.message}` }],
        isError: true,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(timeoutResponse());
        return;
      }
      const text = outputText();
      if (code !== 0 && code !== null) {
        finish({
          content: [{
            type: "text",
            text: text + (text ? "\n\n" : "") + `Command exited with code ${code}`,
          }],
          isError: true,
        });
        return;
      }
      finish({
        content: [{ type: "text", text: text || "(no output)" }],
      });
    });
  });
}