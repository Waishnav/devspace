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
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
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
}

const DEFAULT_READ_MAX_LINES = 20_000;
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

interface DevspaceReadTruncation {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  firstLineExceedsLimit: boolean;
}

interface DevspaceReadDetails {
  truncation?: DevspaceReadTruncation;
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

function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;

  return value;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];

  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();

  return lines;
}

function isLikelyImage(path: string, buffer: Buffer): boolean {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return true;

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return true;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;

  return false;
}

function truncateTextHead(content: string, maxLines: number, maxBytes: number): { content: string; truncation: DevspaceReadTruncation } {
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncation: {
        truncated: false,
        truncatedBy: null,
        totalLines,
        totalBytes,
        outputLines: totalLines,
        outputBytes: totalBytes,
        maxLines,
        maxBytes,
        firstLineExceedsLimit: false,
      },
    };
  }

  if (lines.length > 0 && Buffer.byteLength(lines[0] ?? "", "utf8") > maxBytes) {
    return {
      content: "",
      truncation: {
        truncated: true,
        truncatedBy: "bytes",
        totalLines,
        totalBytes,
        outputLines: 0,
        outputBytes: 0,
        maxLines,
        maxBytes,
        firstLineExceedsLimit: true,
      },
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8");
    const separatorBytes = outputLines.length > 0 ? 1 : 0;

    if (outputBytes + separatorBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputBytes += separatorBytes + lineBytes;
    outputLines.push(line);
  }

  if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  return {
    content: outputLines.join("\n"),
    truncation: {
      truncated: true,
      truncatedBy,
      totalLines,
      totalBytes,
      outputLines: outputLines.length,
      outputBytes,
      maxLines,
      maxBytes,
      firstLineExceedsLimit: false,
    },
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

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse<DevspaceReadDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);

  try {
    const buffer = await readFile(path);
    const tool = createReadTool(context.cwd);

    if (isLikelyImage(path, buffer)) {
      return runTool((params) => tool.execute("read_file", params), {
        path,
        offset: input.offset,
        limit: input.limit,
      }, context);
    }

    const textContent = buffer.toString("utf8");
    const allLines = textContent.split("\n");
    const totalFileLines = allLines.length;
    const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
    const startLineDisplay = startLine + 1;

    if (startLine >= allLines.length) {
      throw new Error(`Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
    }

    const configuredMaxLines = configuredPositiveInteger("DEVSPACE_READ_MAX_LINES", DEFAULT_READ_MAX_LINES);
    const maxBytes = configuredPositiveInteger("DEVSPACE_READ_MAX_BYTES", DEFAULT_READ_MAX_BYTES);
    const maxLines = input.limit === undefined ? configuredMaxLines : Math.min(input.limit, configuredMaxLines);
    const selectedContent = allLines.slice(startLine).join("\n");
    const { content, truncation } = truncateTextHead(selectedContent, maxLines, maxBytes);

    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf8"));
      return {
        content: [{
          type: "text",
          text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(maxBytes)} limit. Use offset/limit or shell chunking to inspect it.]`,
        }],
        details: { truncation },
      };
    }

    let outputText = content;
    const endLineDisplay = truncation.outputLines > 0 ? startLineDisplay + truncation.outputLines - 1 : startLineDisplay;

    if (truncation.truncated) {
      const nextOffset = endLineDisplay + 1;
      const reason = truncation.truncatedBy === "bytes" ? ` (${formatSize(maxBytes)} limit)` : "";
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${reason}. Use offset=${nextOffset} to continue.]`;
    } else if (input.limit !== undefined && startLine + input.limit < allLines.length) {
      const nextOffset = startLine + input.limit + 1;
      const remaining = allLines.length - (startLine + input.limit);
      outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    }

    return {
      content: [{ type: "text", text: outputText }],
      details: truncation.truncated ? { truncation } : undefined,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
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
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
