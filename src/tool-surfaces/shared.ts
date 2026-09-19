import * as z from "zod/v4";
import { logEvent, commandPreview } from "../logger.js";
import type { ServerConfig } from "../config.js";
import type { Workspace, WorkspaceRegistry } from "../workspaces.js";
import {
  WORKSPACE_APP_URI,
  type DiffStats,
  type ToolContent,
  type ToolLogFields,
  type ToolWidgetDescriptorMeta,
} from "./types.js";

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export function workspaceAppDescriptorMeta(config: ServerConfig): ToolWidgetDescriptorMeta {
  if (!config.uiEnabled) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview:
      config.logging.shellCommands && command
        ? commandPreview(command)
        : undefined,
  });
}

export async function runLoggedToolOperation<T>(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  startedAt: number,
  operation: () => Promise<T>,
  resultFields?: (result: T) => Partial<ToolLogFields>,
): Promise<T> {
  try {
    const result = await operation();
    const resultMetadata = resultFields?.(result);
    logToolCall(config, {
      ...fields,
      ...resultMetadata,
      success: resultMetadata?.success ?? true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logToolCall(config, {
      ...fields,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

const SKILL_URI_SHELL_ARGUMENT =
  /"(skills:\/\/[^"\r\n]+)"|'(skills:\/\/[^'\r\n]+)'|(?<![^\s|&;()<>])(skills:\/\/[^\s"'\`|&;()<>]+)/g;

export async function expandSkillUrisInShellCommand(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  command: string,
  shell: "native" | "bash",
): Promise<string> {
  if (!config.experimentalSkillUris || !command.includes("skills://")) {
    return command;
  }

  // Experimental workaround: shell tools cannot consume skills:// URIs themselves.
  // Rewrite only standalone URI arguments until MCP Skills/resources are broadly host-native.
  const matches = Array.from(command.matchAll(SKILL_URI_SHELL_ARGUMENT));
  if (matches.length === 0) return command;

  let expanded = "";
  let offset = 0;
  for (const match of matches) {
    const index = match.index;
    const uri = match[1] ?? match[2] ?? match[3];
    if (index === undefined || uri === undefined) continue;

    const resolved = await workspaces.resolveReadPath(workspace, uri);
    expanded += command.slice(offset, index);
    expanded += quoteShellPath(resolved.absolutePath, shell);
    offset = index + match[0].length;
  }

  return expanded + command.slice(offset);
}

function quoteShellPath(path: string, shell: "native" | "bash"): string {
  if (shell === "native" && process.platform === "win32") {
    return `"${path}"`;
  }

  const shellPath = process.platform === "win32"
    ? path.replace(/\\/g, "/")
    : path;
  return `'${shellPath.replace(/'/g, `'\\''`)}'`;
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
