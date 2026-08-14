import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ElicitResultSchema,
  isInitializeRequest,
  type ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  CodexComputerUseAdapter,
  type CodexComputerUseInput,
} from "./codex-computer-use.js";
import {
  CodexChromeUseAdapter,
  type CodexChromeUseInput,
} from "./codex-chrome-use.js";
import type { CodexMcpToolResult } from "./codex-mcp-client.js";
import type { CodexExecutionContext } from "./codex-request-context.js";
import { CodexRuntimeHost } from "./codex-runtime-host.js";
import {
  captureComputerScreen,
  ComputerUseError,
  isComputerUseSupportedPlatform,
  performComputerAction,
  type ComputerActionInput,
  type ScreenCaptureResult,
} from "./computer-use.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  exportWorkspaceFile,
  isLikelyBinaryFile,
  isModelImageMimeType,
} from "./outgoing-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
  captureScreen: "capture_screen",
  computerAction: "computer_action",
  computerUse: "computer_use",
  chromeUse: "chrome_use",
} as const;

export interface LocalControlAdapters {
  computerUse?: CodexComputerUseAdapter;
  chromeUse?: CodexChromeUseAdapter;
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const artifactExportInstruction = config.artifactsEnabled
    ? " When the user asks to receive, inspect, or download a file that exists on the DevSpace host, use export_file with the existing workspace ID and workspace-relative path. The tool returns the original bytes as an MCP embedded resource with file metadata and integrity information; do not recreate binary content with text tools or place base64 data in shell commands or logs."
    : "";
  const artifactDownloadInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not place signed URLs, native file objects, or invented host paths in shell commands or logs."
    : "";
  const artifactInstruction = `${artifactExportInstruction}${artifactDownloadInstruction}`;
  const computerUseInstruction = !config.computerUseEnabled
    ? ""
    : config.computerUseBackend === "codex"
      ? " For native macOS applications, use computer_use to list apps, observe one app as a screenshot plus accessibility tree, and perform bounded semantic or coordinate actions. For Chrome pages, use chrome_use and prefer DOM snapshots plus Playwright selectors over desktop coordinates. Both tools return fresh state after actions. Chrome Use can operate while macOS is locked; native Computer Use fails closed while locked unless authentic Codex thread metadata is present."
      : isComputerUseSupportedPlatform()
        ? " For legacy desktop computer-use diagnostics, call capture_screen to observe the selected display, then call computer_action to perform one bounded action and receive a fresh screenshot. The read tool also accepts @screen as a compatibility alias for display 1."
        : "";
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${artifactInstruction}${computerUseInstruction}${showChangesInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${artifactInstruction}${computerUseInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

function screenCaptureSummary(capture: ScreenCaptureResult) {
  return {
    display: capture.display.index,
    displayId: capture.display.id,
    originX: capture.display.x,
    originY: capture.display.y,
    screenWidth: capture.display.width,
    screenHeight: capture.display.height,
    imageWidth: capture.width,
    imageHeight: capture.height,
    includeCursor: capture.includeCursor,
    mimeType: capture.mimeType,
    size: capture.size,
    sha256: capture.sha256,
  };
}

function computerUseErrorCode(error: unknown): string {
  if (error instanceof ComputerUseError) return error.code;
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return "internal_error";
}

function codexToolContent(result: CodexMcpToolResult): ToolContent[] {
  return result.content.flatMap((item): ToolContent[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }];
    if (item.type === "image") {
      return [{ type: "image", data: item.data, mimeType: item.mimeType }];
    }
    return [];
  });
}

function codexToolSummary(action: string, result: CodexMcpToolResult) {
  const content = codexToolContent(result);
  return {
    action,
    isError: result.isError,
    text: contentText(content),
    imageCount: content.filter((item) => item.type === "image").length,
  };
}

type CodexElicitationAction = "accept" | "decline" | "cancel";

type CodexElicitationFallback = {
  explicitAction?: CodexElicitationAction;
  onUnsupported?: (params: Record<string, unknown>) => void;
};

function codexExecutionContextFromToolExtra(
  extra: {
    _meta?: unknown;
    sessionId?: string;
    requestId: string | number;
    sendRequest: (
      request: ElicitRequest,
      resultSchema: typeof ElicitResultSchema,
    ) => Promise<unknown>;
  },
  fallback: CodexElicitationFallback = {},
): CodexExecutionContext {
  return {
    requestMeta:
      typeof extra._meta === "object" && extra._meta !== null && !Array.isArray(extra._meta)
        ? extra._meta as Record<string, unknown>
        : undefined,
    mcpSessionId: extra.sessionId,
    requestId: extra.requestId,
    onElicitation: async (params) => {
      if (fallback.explicitAction) {
        return { action: fallback.explicitAction, content: {} };
      }
      try {
        const result = await extra.sendRequest(
          { method: "elicitation/create", params } as ElicitRequest,
          ElicitResultSchema,
        );
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new Error("MCP client returned an invalid elicitation response.");
        }
        return result as Record<string, unknown>;
      } catch (error) {
        if (!fallback.onUnsupported) throw error;
        fallback.onUnsupported(params);
        return { action: "decline", content: {} };
      }
    },
  };
}

function summarizeElicitation(params: Record<string, unknown>): {
  message: string;
  requestedSchema?: unknown;
} {
  return {
    message: typeof params.message === "string"
      ? params.message
      : "This action requires explicit user approval.",
    ...(typeof params.requestedSchema === "object" && params.requestedSchema !== null
      ? { requestedSchema: params.requestedSchema }
      : {}),
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
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

function logFailedToolResponse(
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

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  localControls: LocalControlAdapters,
): McpServer {
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
        agents: z.array(workspaceLocalAgentOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const visibleAgentProviders = config.subagents ? localAgentProviders : [];
      const visibleAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = visibleAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              mode: workspace.mode,
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              agentProviders: visibleAgentProviders.length,
              agents: visibleAgents.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          agentProviders: visibleAgentProviders,
          agents: visibleAgents,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          config.computerUseEnabled && config.computerUseBackend === "swift"
            ? "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId. With the legacy Swift computer-use backend, path @screen captures display 1 as native image content."
            : "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      if (
        config.computerUseEnabled
        && config.computerUseBackend === "swift"
        && input.path === "@screen"
        && input.offset === undefined
        && input.limit === undefined
      ) {
        const capture = await captureComputerScreen({
          stateDir: config.stateDir,
          maxFileBytes: config.artifactMaxFileBytes,
          display: 1,
          includeCursor: true,
        });
        const result = screenCaptureSummary(capture);
        const resultText = JSON.stringify(result);
        logToolCall(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [
            { type: "text" as const, text: resultText },
            { type: "image" as const, data: capture.data, mimeType: capture.mimeType },
          ],
          _meta: {
            tool: toolNames.read,
            card: {
              workspaceId,
              path: input.path,
              summary: result,
            },
          },
          structuredContent: { result: resultText },
        };
      }
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      if (
        config.artifactsEnabled
        && input.offset === undefined
        && input.limit === undefined
        && readPath.skillRead === undefined
        && isLikelyBinaryFile(input.path)
      ) {
        const exported = await exportWorkspaceFile({
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          maxFileBytes: config.artifactMaxFileBytes,
          path: input.path,
        });
        const result = {
          path: exported.path,
          name: exported.name,
          mimeType: exported.mimeType,
          size: exported.size,
          sha256: exported.sha256,
        };
        const resultText = JSON.stringify(result);
        logToolCall(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        const binaryContent = isModelImageMimeType(exported.mimeType)
          ? { type: "image" as const, data: exported.blob, mimeType: exported.mimeType }
          : {
              type: "resource" as const,
              resource: {
                uri: exported.uri,
                mimeType: exported.mimeType,
                blob: exported.blob,
              },
            };
        return {
          content: [
            { type: "text" as const, text: resultText },
            binaryContent,
          ],
          _meta: {
            tool: toolNames.read,
            card: {
              workspaceId,
              path: input.path,
              summary: result,
            },
          },
          structuredContent: {
            result: resultText,
          },
        };
      }
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (localControls.computerUse) {
    registerAppTool(
      server,
      toolNames.computerUse,
      {
        title: "Use a macOS application",
        description:
          "Use OpenAI's signed Codex Computer Use runtime to list applications, observe one application as a screenshot plus accessibility tree, or perform one bounded action. Call get_app_state before interacting and use element indices from the latest state when possible. Actions return fresh application state. Native application control fails closed while macOS is locked unless the incoming request contains authentic Codex thread metadata. If the MCP host cannot render the official application approval elicitation, the result returns approvalRequired; retry with appApproval only after the user has explicitly approved or declined that bounded request.",
        inputSchema: {
          workspaceId: z.string().min(1).describe(
            "Workspace identifier returned by open_workspace. It authorizes this local-control session.",
          ),
          action: z.enum([
            "list_apps",
            "get_app_state",
            "click",
            "perform_secondary_action",
            "set_value",
            "select_text",
            "scroll",
            "drag",
            "press_key",
            "type_text",
          ]),
          app: z.string().max(1024).optional().describe(
            "Application name, full path, or unambiguous bundle identifier. Required except for list_apps.",
          ),
          appApproval: z.enum(["accept", "decline", "cancel"]).optional().describe(
            "Legacy explicit response to an official application approval request. Set accept only after the user has approved this bounded action.",
          ),
          elicitationAction: z.enum(["accept", "decline", "cancel"]).optional().describe(
            "Explicit response to the immediately preceding application approval request. Set accept only after the user has approved that bounded request.",
          ),
          elementIndex: z.string().max(256).optional().describe(
            "Accessibility element index from the latest application state.",
          ),
          x: z.number().finite().optional(),
          y: z.number().finite().optional(),
          clickCount: z.number().int().min(1).max(3).optional(),
          mouseButton: z.enum(["left", "right", "middle"]).optional(),
          secondaryAction: z.string().max(1024).optional(),
          value: z.string().max(100000).optional().describe(
            "Value for set_value. Value content is not written to normal logs.",
          ),
          text: z.string().max(100000).optional().describe(
            "Text for select_text or type_text. Text content is not written to normal logs.",
          ),
          prefix: z.string().max(100000).optional(),
          suffix: z.string().max(100000).optional(),
          selection: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          pages: z.number().positive().max(100).optional(),
          fromX: z.number().finite().optional(),
          fromY: z.number().finite().optional(),
          toX: z.number().finite().optional(),
          toY: z.number().finite().optional(),
          key: z.string().max(256).optional(),
        },
        outputSchema: {
          action: z.string(),
          isError: z.boolean(),
          text: z.string(),
          imageCount: z.number().int().nonnegative(),
          approvalRequired: z.boolean().optional(),
          approvalMessage: z.string().optional(),
          approvalSchema: z.unknown().optional(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, appApproval, elicitationAction, ...input }, extra) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const action = input.action;
        let unsupportedElicitation: ReturnType<typeof summarizeElicitation> | undefined;
        try {
          const result = await localControls.computerUse!.invoke(
            input as CodexComputerUseInput,
            codexExecutionContextFromToolExtra(extra, {
              explicitAction: elicitationAction ?? appApproval,
              onUnsupported: (params) => {
                unsupportedElicitation = summarizeElicitation(params);
              },
            }),
          );
          if (unsupportedElicitation) {
            const summary = {
              action,
              isError: false,
              text: unsupportedElicitation.message,
              imageCount: 0,
              approvalRequired: true,
              approvalMessage: unsupportedElicitation.message,
              ...(unsupportedElicitation.requestedSchema === undefined
                ? {}
                : { approvalSchema: unsupportedElicitation.requestedSchema }),
            };
            logEvent(config.logging, "info", "computer_use_tool_call", {
              backend: "codex",
              tool: toolNames.computerUse,
              workspaceId,
              action,
              appPresent: input.app !== undefined,
              approvalRequired: true,
              success: false,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(summary) }],
              isError: false,
              structuredContent: summary,
            };
          }
          const summary = codexToolSummary(action, result);
          const content = codexToolContent(result);
          logEvent(config.logging, result.isError ? "warn" : "info", "computer_use_tool_call", {
            backend: "codex",
            tool: toolNames.computerUse,
            workspaceId,
            action,
            appPresent: input.app !== undefined,
            hasCoordinates: input.x !== undefined || input.y !== undefined,
            hasText: input.text !== undefined || input.value !== undefined,
            imageCount: summary.imageCount,
            success: !result.isError,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: content.length > 0
              ? content
              : [{ type: "text" as const, text: JSON.stringify(summary) }],
            isError: result.isError,
            structuredContent: summary,
          };
        } catch (error) {
          logEvent(config.logging, "warn", "computer_use_tool_call", {
            backend: "codex",
            tool: toolNames.computerUse,
            workspaceId,
            action,
            success: false,
            errorCode: computerUseErrorCode(error),
            durationMs: Math.round(performance.now() - startedAt),
          });
          throw error;
        }
      },
    );
  }

  if (localControls.chromeUse) {
    registerAppTool(
      server,
      toolNames.chromeUse,
      {
        title: "Use Google Chrome",
        description:
          "Use the signed Codex Chrome runtime with the user's real Chrome profiles. Call open_workspace first and reuse its workspaceId. Use list_profiles to inspect profiles and status to verify the selected profile. The machine default is used unless this ChatGPT conversation selects another profile by name, Google account email, or profile path. Profile selection is sticky within the conversation. Supports isolated tabs, explicitly claimed user tabs, navigation, DOM snapshots, screenshots, and Playwright-based interactions. Prefer DOM and selectors over coordinates. Existing user tabs remain untouched unless list_user_tabs or claim_tab is explicitly requested. Read the devspace-chrome-use skill before Chrome work.",
        inputSchema: {
          workspaceId: z.string().min(1).describe(
            "Workspace identifier returned by open_workspace. It authorizes this browser-control session.",
          ),
          action: z.enum([
            "status",
            "list_profiles",
            "list_tabs",
            "list_user_tabs",
            "new_tab",
            "claim_tab",
            "goto",
            "snapshot",
            "screenshot",
            "click",
            "fill",
            "type",
            "press",
            "reload",
            "wait",
            "close",
          ]),
          profile: z.string().max(512).optional().describe(
            "Optional Chrome profile selector by profile name, Google account email, or profile path. When supplied, it becomes the sticky profile for this ChatGPT conversation. Omit it to use the conversation's current profile or the machine default.",
          ),
          tabId: z.string().max(1024).optional().describe(
            "Controlled tab identifier returned by new_tab, claim_tab, or list_tabs.",
          ),
          userTabId: z.string().max(1024).optional().describe(
            "Existing user-tab identifier returned by list_user_tabs. Required for claim_tab.",
          ),
          url: z.string().max(8192).optional().describe(
            "Absolute http, https, or file URL for new_tab or goto.",
          ),
          selector: z.string().max(8192).optional().describe(
            "Playwright selector for click, fill, type, or press.",
          ),
          text: z.string().max(100000).optional().describe(
            "Text for fill or type. Text content is not written to normal logs.",
          ),
          key: z.string().max(256).optional(),
          timeoutMs: z.number().int().min(0).max(120000).optional(),
          fullPage: z.boolean().optional(),
          observe: z.enum(["none", "dom", "screenshot", "both"]).optional().describe(
            "Fresh observation returned after the action. Mutating actions default to dom.",
          ),
        },
        outputSchema: {
          action: z.string(),
          isError: z.boolean(),
          text: z.string(),
          imageCount: z.number().int().nonnegative(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const action = input.action;
        try {
          const result = await localControls.chromeUse!.invoke(
            input as CodexChromeUseInput,
            codexExecutionContextFromToolExtra(extra),
          );
          const summary = codexToolSummary(action, result);
          const content = codexToolContent(result);
          logEvent(config.logging, result.isError ? "warn" : "info", "chrome_use_tool_call", {
            tool: toolNames.chromeUse,
            workspaceId,
            action,
            tabIdPresent: input.tabId !== undefined,
            urlPresent: input.url !== undefined,
            selectorPresent: input.selector !== undefined,
            hasText: input.text !== undefined,
            imageCount: summary.imageCount,
            success: !result.isError,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: content.length > 0
              ? content
              : [{ type: "text" as const, text: JSON.stringify(summary) }],
            isError: result.isError,
            structuredContent: summary,
          };
        } catch (error) {
          logEvent(config.logging, "warn", "chrome_use_tool_call", {
            tool: toolNames.chromeUse,
            workspaceId,
            action,
            success: false,
            errorCode: computerUseErrorCode(error),
            durationMs: Math.round(performance.now() - startedAt),
          });
          throw error;
        }
      },
    );
  }

  if (
    config.computerUseEnabled
    && config.computerUseBackend === "swift"
    && isComputerUseSupportedPlatform()
  ) {
    registerAppTool(
      server,
      toolNames.captureScreen,
      {
        title: "Capture desktop screen",
        description:
          "Capture one macOS display and return the screenshot as native image content for multimodal inspection. Coordinates in the returned image correspond to display-relative coordinates accepted by computer_action.",
        inputSchema: {
          workspaceId: z.string().min(1).describe(
            "Workspace identifier returned by open_workspace. It authorizes this computer-use session.",
          ),
          display: z.number().int().positive().optional().describe(
            "1-based display index. Display 1 is the main display.",
          ),
          includeCursor: z.boolean().optional().describe(
            "Whether the mouse cursor should be visible in the screenshot. Defaults to true.",
          ),
        },
        outputSchema: {
          display: z.number().int().positive(),
          displayId: z.number().int().nonnegative(),
          originX: z.number(),
          originY: z.number(),
          screenWidth: z.number().positive(),
          screenHeight: z.number().positive(),
          imageWidth: z.number().int().positive(),
          imageHeight: z.number().int().positive(),
          includeCursor: z.boolean(),
          mimeType: z.literal("image/png"),
          size: z.number().int().positive(),
          sha256: z.string(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, display, includeCursor }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        try {
          const capture = await captureComputerScreen({
            stateDir: config.stateDir,
            maxFileBytes: config.artifactMaxFileBytes,
            display,
            includeCursor,
          });
          const result = screenCaptureSummary(capture);
          logToolCall(config, {
            tool: toolNames.captureScreen,
            workspaceId,
            path: `display:${result.display}`,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
              { type: "image" as const, data: capture.data, mimeType: capture.mimeType },
            ],
            structuredContent: result,
          };
        } catch (error) {
          logEvent(config.logging, "warn", "computer_use_tool_call", {
            tool: toolNames.captureScreen,
            workspaceId,
            display,
            success: false,
            errorCode: computerUseErrorCode(error),
            durationMs: Math.round(performance.now() - startedAt),
          });
          throw error;
        }
      },
    );

    registerAppTool(
      server,
      toolNames.computerAction,
      {
        title: "Control desktop computer",
        description:
          "Perform one macOS desktop action, wait briefly for the UI to settle, and return a fresh screenshot. Supported actions: move, click, double_click, right_click, drag, scroll, key, type_text, activate_app, wait, and request_permissions. Mouse coordinates are relative to the selected display screenshot.",
        inputSchema: {
          workspaceId: z.string().min(1).describe(
            "Workspace identifier returned by open_workspace. It authorizes this computer-use session.",
          ),
          action: z.enum([
            "move",
            "click",
            "double_click",
            "right_click",
            "drag",
            "scroll",
            "key",
            "type_text",
            "activate_app",
            "wait",
            "request_permissions",
          ]),
          display: z.number().int().positive().optional().describe(
            "1-based display index. Defaults to display 1.",
          ),
          x: z.number().optional().describe(
            "Display-relative horizontal coordinate for pointer actions.",
          ),
          y: z.number().optional().describe(
            "Display-relative vertical coordinate for pointer actions.",
          ),
          endX: z.number().optional().describe(
            "Display-relative drag destination x coordinate.",
          ),
          endY: z.number().optional().describe(
            "Display-relative drag destination y coordinate.",
          ),
          button: z.enum(["left", "right", "center"]).optional(),
          deltaX: z.number().int().min(-100000).max(100000).optional().describe(
            "Horizontal pixel scroll amount.",
          ),
          deltaY: z.number().int().min(-100000).max(100000).optional().describe(
            "Vertical pixel scroll amount. Positive values scroll upward.",
          ),
          durationMs: z.number().int().min(0).max(30000).optional().describe(
            "Drag duration or wait duration in milliseconds.",
          ),
          key: z.string().max(32).optional().describe(
            "Named key such as return, tab, escape, left, right, up, down, f1, or a single alphanumeric key.",
          ),
          modifiers: z.array(
            z.enum(["command", "control", "option", "shift", "function"]),
          ).max(5).optional(),
          text: z.string().max(65536).optional().describe(
            "Unicode text for type_text. The text is never written to tool logs.",
          ),
          app: z.string().max(256).optional().describe(
            "Application name or bundle identifier for activate_app.",
          ),
          settleMs: z.number().int().min(0).max(5000).optional().describe(
            "Delay after the action before taking the screenshot. Defaults to 250 ms.",
          ),
          includeCursor: z.boolean().optional().describe(
            "Whether the post-action screenshot includes the cursor. Defaults to true.",
          ),
        },
        outputSchema: {
          action: z.string(),
          permissions: z.object({
            screenCapture: z.boolean(),
            accessibility: z.boolean(),
          }),
          cursor: z.object({ x: z.number(), y: z.number() }).optional(),
          screenshot: z.object({
            display: z.number().int().positive(),
            displayId: z.number().int().nonnegative(),
            originX: z.number(),
            originY: z.number(),
            screenWidth: z.number().positive(),
            screenHeight: z.number().positive(),
            imageWidth: z.number().int().positive(),
            imageHeight: z.number().int().positive(),
            includeCursor: z.boolean(),
            mimeType: z.literal("image/png"),
            size: z.number().int().positive(),
            sha256: z.string(),
          }).optional(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, settleMs, includeCursor, ...rawAction }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const safeLogFields = {
          tool: toolNames.computerAction,
          workspaceId,
          action: rawAction.action,
          display: rawAction.display,
          hasCoordinates: rawAction.x !== undefined || rawAction.y !== undefined,
          hasText: rawAction.text !== undefined,
        };
        try {
          const actionResult = await performComputerAction(
            config.stateDir,
            rawAction as ComputerActionInput,
          );
          const delayMs = settleMs ?? (rawAction.action === "wait" ? 0 : 250);
          if (delayMs > 0) await sleep(delayMs);

          let capture: ScreenCaptureResult | undefined;
          if (actionResult.permissions.screenCapture) {
            capture = await captureComputerScreen({
              stateDir: config.stateDir,
              maxFileBytes: config.artifactMaxFileBytes,
              display: rawAction.display ?? 1,
              includeCursor,
            });
          }
          const result = {
            action: actionResult.action,
            permissions: actionResult.permissions,
            cursor: actionResult.cursor,
            screenshot: capture ? screenCaptureSummary(capture) : undefined,
          };
          logEvent(config.logging, "info", "computer_use_tool_call", {
            ...safeLogFields,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
              ...(capture
                ? [{ type: "image" as const, data: capture.data, mimeType: capture.mimeType }]
                : []),
            ],
            structuredContent: result,
          };
        } catch (error) {
          logEvent(config.logging, "warn", "computer_use_tool_call", {
            ...safeLogFields,
            success: false,
            errorCode: computerUseErrorCode(error),
            durationMs: Math.round(performance.now() - startedAt),
          });
          throw error;
        }
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes for an open workspace. If the current turn successfully modified files, call this exactly once after the final related file change and before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual file change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  if (config.artifactsEnabled) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];
  const codexRuntimeHost = config.computerUseEnabled && config.computerUseBackend === "codex"
    ? new CodexRuntimeHost({
        onAppServerMethod: (method) => {
          logEvent(config.logging, "debug", "codex_app_server_method", { method });
        },
      })
    : undefined;
  const localControls: LocalControlAdapters = codexRuntimeHost
    ? {
        computerUse: new CodexComputerUseAdapter(codexRuntimeHost),
        chromeUse: new CodexChromeUseAdapter(codexRuntimeHost, {
          defaultProfile: config.chromeDefaultProfile,
        }),
      }
    : {};

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace", toolMode: config.toolMode, widgets: config.widgets });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          localControls,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        await localControls.computerUse?.close().catch(() => undefined);
        await localControls.chromeUse?.close().catch(() => undefined);
        await codexRuntimeHost?.close().catch(() => undefined);
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native file export: ${config.artifactsEnabled ? "enabled" : "disabled"}`);
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    const computerUseStatus = !config.computerUseEnabled
      ? "disabled"
      : !isComputerUseSupportedPlatform()
        ? `unsupported on ${process.platform}`
        : config.computerUseBackend === "codex"
          ? "enabled (Codex Computer Use + Chrome Use)"
          : "enabled (legacy Swift rollback backend)";
    console.log(`local computer control: ${computerUseStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
