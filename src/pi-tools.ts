import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { expandHomePath, resolveAllowedPath } from "./roots.js";
import {
  diagnoseRuntime,
  openPathInFinder,
  runCompatibilitySmoke,
} from "./runtime-operations.js";
import { commandWithAugmentedPath } from "./shell-environment.js";
import { getExecutionCostSnapshot } from "./usage-meter.js";

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

interface ApprovedShellCommand {
  alias: string;
  enabled?: boolean;
  workspaceRoot: string;
  workingDirectory?: string;
  command: string;
}

const approvedCommandPrefix = "devspace-approved ";
const runtimeCommandPrefix = "devspace-runtime";

function textResponse(text: string, isError = false): ToolResponse {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResponse(value: unknown): ToolResponse {
  return textResponse(JSON.stringify(value, null, 2));
}

async function runBuiltinRuntimeCommand(
  input: BashToolInput,
  context: ToolContext,
): Promise<ToolResponse | undefined> {
  const rawCommand = String(input.command ?? "").trim();
  if (
    rawCommand !== runtimeCommandPrefix
    && !rawCommand.startsWith(`${runtimeCommandPrefix} `)
  ) return undefined;

  if (
    rawCommand === runtimeCommandPrefix
    || rawCommand === `${runtimeCommandPrefix} help`
  ) {
    return textResponse([
      "Built-in DevSpace runtime commands:",
      "  devspace-runtime diagnose [--github] [command ...]",
      "  devspace-runtime smoke",
      "  devspace-runtime costs",
      "  devspace-runtime finder <workspace-relative-path>",
    ].join("\n"));
  }

  if (rawCommand === `${runtimeCommandPrefix} costs`) {
    return jsonResponse(getExecutionCostSnapshot());
  }

  if (rawCommand === `${runtimeCommandPrefix} smoke`) {
    const result = await runCompatibilitySmoke(context.root);
    return {
      ...jsonResponse(result),
      ...(result.status === "failed" ? { isError: true } : {}),
    };
  }

  if (
    rawCommand === `${runtimeCommandPrefix} diagnose`
    || rawCommand.startsWith(`${runtimeCommandPrefix} diagnose `)
  ) {
    const args = rawCommand
      .slice(`${runtimeCommandPrefix} diagnose`.length)
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const checkGitHubAuth = args.includes("--github");
    const commands = args
      .filter((arg) => arg !== "--github")
      .filter((arg) => /^[A-Za-z0-9._+-]+$/u.test(arg))
      .slice(0, 20);
    const result = await diagnoseRuntime({
      workspaceRoot: context.root,
      commands: commands.length > 0 ? commands : undefined,
      checkGitHubAuth,
    });
    return jsonResponse(result);
  }

  if (rawCommand.startsWith(`${runtimeCommandPrefix} finder `)) {
    const rawPath = rawCommand
      .slice(`${runtimeCommandPrefix} finder `.length)
      .trim();
    const requestedPath = (
      (rawPath.startsWith("\"") && rawPath.endsWith("\""))
      || (rawPath.startsWith("'") && rawPath.endsWith("'"))
    ) ? rawPath.slice(1, -1) : rawPath;
    if (!requestedPath) {
      return textResponse("Finder path is required.", true);
    }
    try {
      const absolutePath = resolveAllowedPath(requestedPath, context.cwd, [context.root]);
      return jsonResponse(await openPathInFinder(absolutePath));
    } catch (error) {
      return textResponse(error instanceof Error ? error.message : String(error), true);
    }
  }

  return textResponse(
    "Unknown devspace-runtime command. Run `devspace-runtime help`.",
    true,
  );
}
function approvedCommandsPath(): string {
  return resolve(expandHomePath(
    process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE
      ?? join(homedir(), ".devspace", "approved-shell-commands.json"),
  ));
}

async function loadApprovedShellCommands(): Promise<ApprovedShellCommand[]> {
  try {
    const raw = await readFile(approvedCommandsPath(), "utf8");
    const parsed = JSON.parse(raw) as { commands?: ApprovedShellCommand[] };
    return Array.isArray(parsed.commands) ? parsed.commands : [];
  } catch {
    return [];
  }
}

async function resolveApprovedShellAlias(
  input: BashToolInput,
  context: ToolContext,
): Promise<{ input: BashToolInput; cwd: string }> {
  const rawCommand = String(input.command ?? "").trim();
  if (!rawCommand.startsWith(approvedCommandPrefix)) {
    return { input, cwd: context.cwd };
  }

  const alias = rawCommand.slice(approvedCommandPrefix.length).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    throw new Error("Invalid approved shell command alias.");
  }

  const commands = await loadApprovedShellCommands();
  const command = commands.find(
    (entry) => entry?.enabled !== false && entry?.alias === alias,
  );
  if (!command) {
    throw new Error(`Approved shell command alias is not configured: ${alias}`);
  }

  const configuredRoot = String(command.workspaceRoot ?? "").trim();
  if (!configuredRoot) {
    throw new Error(`Approved shell command has no workspace root: ${alias}`);
  }

  const expectedRoot = resolve(expandHomePath(configuredRoot));
  const actualRoot = resolve(context.root);
  if (expectedRoot !== actualRoot) {
    throw new Error(`Approved shell command alias is not allowed for this workspace: ${alias}`);
  }

  const approvedCwd = resolveAllowedPath(
    String(command.workingDirectory ?? "."),
    actualRoot,
    [actualRoot],
  );
  const approvedCommand = String(command.command ?? "").trim();
  if (!approvedCommand) {
    throw new Error(`Approved shell command is empty: ${alias}`);
  }

  return {
    input: {
      ...input,
      command: approvedCommand,
    },
    cwd: approvedCwd,
  };
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
  const builtin = await runBuiltinRuntimeCommand(input, context);
  if (builtin) return builtin;

  let approved: { input: BashToolInput; cwd: string };
  try {
    approved = await resolveApprovedShellAlias(input, context);
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }

  const tool = createBashTool(approved.cwd);
  const timeout =
    approved.input.timeout === undefined
      ? 30
      : Math.min(approved.input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: commandWithAugmentedPath(approved.input.command),
    timeout,
  }, context);
}
