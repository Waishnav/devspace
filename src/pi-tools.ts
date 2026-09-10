import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
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
  expectedBeforeHash?: string;
  afterPreconditionCheck?: () => Promise<void>;
}

const fileMutationQueues = new Map<string, Promise<void>>();

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

  return withFileMutationLock(path, async () => {
    const preconditionError = await checkExpectedBeforeHash(path, context.expectedBeforeHash);
    if (preconditionError) return { content: formatToolError(preconditionError), isError: true };
    await context.afterPreconditionCheck?.();
    const tool = createWriteTool(context.cwd);

    return runTool((params) => tool.execute("write_file", params), {
      path,
      content: input.content,
    }, context);
  });
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);

  return withFileMutationLock(path, async () => {
    const preconditionError = await checkExpectedBeforeHash(path, context.expectedBeforeHash);
    if (preconditionError) return { content: formatToolError(preconditionError), isError: true };
    await context.afterPreconditionCheck?.();
    const tool = createEditTool(context.cwd);

    return runTool((params) => tool.execute("edit_file", params), {
      path,
      edits: input.edits,
    }, context);
  });
}

async function withFileMutationLock<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  fileMutationQueues.set(path, tail);

  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (fileMutationQueues.get(path) === tail) fileMutationQueues.delete(path);
  }
}

async function checkExpectedBeforeHash(path: string, expectedBeforeHash: string | undefined): Promise<Error | undefined> {
  if (expectedBeforeHash === undefined) return undefined;
  const actual = await fileContentHash(path);
  if (actual === expectedBeforeHash) return undefined;
  return new Error(`File precondition failed: expected ${expectedBeforeHash}, found ${actual}.`);
}

async function fileContentHash(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
