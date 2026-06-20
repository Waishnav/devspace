import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
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
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { validateShellCommand } from "./shell-policy.js";
import { formatPathForPrompt } from "./skills.js";
import { contentStats, contentText, toolError, type ToolContent } from "./tool-result.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { serverInstructions as buildServerInstructions, workspaceInstruction } from "./prompting.js";
import { parseAnswerTextOrThrow, parseWorkspaceCommand } from "./workspace-commands.js";
import { applyWorkspacePatch, gitPush } from "./workspace-operations.js";
import type {
  WorkspaceStore,
  WorkspacePlanStep,
  WorkspaceQuestion,
  WorkspaceUserInputAnswer,
  WorkspaceUserInputRecord,
} from "./workspace-store.js";

type Transport = StreamableHTTPServerTransport;
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
}

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
  | "plan"
  | "goal"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "safe_operation"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
  "ui/resourceUri": string;
  "openai/outputTemplate": string;
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
      "ui/resourceUri": WORKSPACE_APP_URI,
      "openai/outputTemplate": WORKSPACE_APP_URI,
    },
  };
}

export interface ToolNames {
  openWorkspace: "open_workspace";
  read: "read_file" | "read";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
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

function toolNamesFor(config: ServerConfig): ToolNames {
  return config.toolNaming === "short"
    ? {
        openWorkspace: "open_workspace",
        read: "read",
        write: "write",
        edit: "edit",
        grep: "grep",
        glob: "glob",
        ls: "ls",
        shell: "bash",
      }
    : {
        openWorkspace: "open_workspace",
        read: "read_file",
        write: "write_file",
        edit: "edit_file",
        grep: "grep_files",
        glob: "find_files",
        ls: "list_directory",
        shell: "run_shell",
      };
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

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const userInputAnswerOutputSchema = z.object({
  questionId: z.string(),
  label: z.string(),
});

const userInputPromptOutputSchema = z.object({
  questions: z.array(
    z.object({
      header: z.string(),
      id: z.string(),
      question: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  autoResolutionMs: z.number().int().min(60000).max(240000).optional(),
  status: z.enum(["pending", "completed", "declined", "cancelled"]),
  deliveryMode: z.enum(["elicitation", "tool", "ui"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answeredAt: z.string().optional(),
  response: z
    .object({
      answers: z.array(userInputAnswerOutputSchema),
      summary: z.string(),
      source: z.enum(["elicitation", "tool", "ui"]),
      action: z.enum(["accept", "decline", "cancel"]),
    })
    .optional(),
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

function openAiWidgetCsp(config: ServerConfig): {
  resource_domains: string[];
  connect_domains: string[];
} {
  const csp = appCsp(config);
  return {
    resource_domains: csp.resourceDomains,
    connect_domains: csp.connectDomains,
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

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  workspaceStore: WorkspaceStore,
): McpServer {
  const toolNames = toolNamesFor(config);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: buildServerInstructions(
        {
          minimalTools: config.minimalTools,
          skillsEnabled: config.skillsEnabled,
          widgetsChangesOnly: config.widgets === "changes",
        },
        toolNames,
      ),
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
        "openai/widgetDescription": "Interactive DevSpace workspace and file-change view.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": openAiWidgetCsp(config),
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
              "openai/widgetDescription": "Interactive DevSpace workspace and file-change view.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetCSP": openAiWidgetCsp(config),
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
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
        collaborationMode: z.enum(["default", "plan"]),
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
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const collaboration = workspaceStore.getCollaborationMode(workspace.id);
      const instruction = workspaceInstruction(collaboration.mode, config.skillsEnabled);
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
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
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
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
          collaborationMode: collaboration.mode,
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_collaboration_mode",
    {
      title: "Get collaboration mode",
      description:
        "Get the workspace collaboration mode. Use this to tell whether the workspace is in default execution mode or plan mode.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        result: z.string(),
        mode: z.enum(["default", "plan"]),
        updatedAt: z.string().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const collaboration = workspaceStore.getCollaborationMode(workspaceId);
      const content = [textBlock(`Workspace collaboration mode: ${collaboration.mode}`)];

      logToolCall(config, {
        tool: "get_collaboration_mode",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          mode: collaboration.mode,
          updatedAt: collaboration.updatedAt || undefined,
        },
      };
    },
  );

  registerAppTool(
    server,
    "set_collaboration_mode",
    {
      title: "Set collaboration mode",
      description:
        "Set the workspace collaboration mode. Use plan mode when the task should stay in exploration and specification until the plan is complete.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        mode: z.enum(["default", "plan"]),
      },
      outputSchema: {
        result: z.string(),
        mode: z.enum(["default", "plan"]),
        updatedAt: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, mode }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const collaboration = workspaceStore.setCollaborationMode({
        workspaceSessionId: workspaceId,
        mode,
      });
      const content = [textBlock(`Workspace collaboration mode set to ${collaboration.mode}.`)];

      logToolCall(config, {
        tool: "set_collaboration_mode",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          mode: collaboration.mode,
          updatedAt: collaboration.updatedAt,
        },
      };
    },
  );

  registerAppTool(
    server,
    "handle_workspace_command",
    {
      title: "Handle workspace command",
      description:
        "Interpret concise workflow messages such as /plan, /goal, and compact answers for the current workspace.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        message: z.string().describe("Raw user message, such as /plan fix this, /goal ship this, or 1B, 2A."),
      },
      outputSchema: {
        result: z.string(),
        recognized: z.boolean(),
        command: z.enum(["plan", "goal", "answer", "none"]),
        mode: z.enum(["default", "plan"]).optional(),
        goal: z
          .object({
            objective: z.string(),
            status: z.enum(["active", "complete", "blocked"]),
            tokenBudget: z.number().int().positive().optional(),
            createdAt: z.string(),
            updatedAt: z.string(),
            timeUsedSeconds: z.number().int().nonnegative(),
            completedAt: z.string().optional(),
            blockedAt: z.string().optional(),
          })
          .optional(),
        prompt: userInputPromptOutputSchema.optional(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, message }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const pending = workspaceStore.getPendingUserInput(workspaceId);
      const parsed = parseWorkspaceCommand(message, pending);

      if (!parsed.recognized || parsed.kind === "none") {
        const content = [textBlock("No workflow command recognized.")];
        logToolCall(config, {
          tool: "handle_workspace_command",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          structuredContent: {
            result: contentText(content),
            recognized: false,
            command: "none" as const,
          },
        };
      }

      if (parsed.kind === "plan") {
        const collaboration = workspaceStore.setCollaborationMode({
          workspaceSessionId: workspaceId,
          mode: "plan",
        });
        const content = [textBlock(parsed.argument ? `Plan mode on\n${parsed.argument}` : "Plan mode on")];
        logToolCall(config, {
          tool: "handle_workspace_command",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          structuredContent: {
            result: contentText(content),
            recognized: true,
            command: "plan" as const,
            mode: collaboration.mode,
          },
        };
      }

      if (parsed.kind === "goal") {
        if (!parsed.argument) {
          const response = toolError("Goal command is missing an objective.");
          logFailedToolResponse(config, {
            tool: "handle_workspace_command",
            workspaceId,
          }, response.content, startedAt);
          return response;
        }

        const goal = workspaceStore.saveGoal({
          workspaceSessionId: workspaceId,
          objective: parsed.argument,
        });
        const content = [textBlock("Goal created")];
        logToolCall(config, {
          tool: "handle_workspace_command",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          structuredContent: {
            result: contentText(content),
            recognized: true,
            command: "goal" as const,
            goal: {
              objective: goal.objective,
              status: goal.status,
              tokenBudget: goal.tokenBudget,
              createdAt: goal.createdAt,
              updatedAt: goal.updatedAt,
              timeUsedSeconds: goal.timeUsedSeconds,
              completedAt: goal.completedAt,
              blockedAt: goal.blockedAt,
            },
          },
        };
      }

      if (!pending) {
        const response = toolError("No pending user-input request exists for this workspace.");
        logFailedToolResponse(config, {
          tool: "handle_workspace_command",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }

      if (parsed.error) {
        const response = toolError(parsed.error);
        logFailedToolResponse(config, {
          tool: "handle_workspace_command",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }

      const answers = parsed.answers ?? [];
      validateSubmittedAnswers(pending, answers);
      const summary = summarizeSubmittedAnswers(pending, answers);
      const completed = workspaceStore.completeUserInput({
        workspaceSessionId: workspaceId,
        answers,
        summary,
        source: "tool",
      });
      const content = [textBlock("Answer recorded")];

      logToolCall(config, {
        tool: "handle_workspace_command",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: "answer_user_input",
          card: {
            workspaceId,
            status: completed.status,
            summary: {
              answered: completed.response?.answers.length ?? 0,
            },
            payload: { content },
            userInput: toStructuredUserInputRecord(completed),
          },
        },
        structuredContent: {
          result: contentText(content),
          recognized: true,
          command: "answer" as const,
          prompt: toStructuredUserInputRecord(completed),
        },
      };
    },
  );

  registerAppTool(
    server,
    "request_user_input",
    {
      title: "Request user input",
      description:
        "Store a structured user-input request for the current workspace. Use this primarily in plan mode when an implementation choice or product preference materially affects the plan.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        autoResolutionMs: z.number().int().min(60000).max(240000).optional(),
        questions: z
          .array(
            z.object({
              header: z.string(),
              id: z.string(),
              question: z.string(),
              options: z
                .array(
                  z.object({
                    label: z.string(),
                    description: z.string(),
                  }),
                )
                .min(2)
                .max(3),
            }),
          )
          .min(1)
          .max(3),
      },
      outputSchema: {
        result: z.string(),
        status: z.enum(["pending", "completed", "declined", "cancelled"]),
        delivery: z.enum([
          "elicitation_completed",
          "elicitation_declined",
          "elicitation_cancelled",
          "pending_fallback",
        ]),
        prompt: userInputPromptOutputSchema,
        response: z
          .object({
            answers: z.array(userInputAnswerOutputSchema),
            summary: z.string(),
            source: z.enum(["elicitation", "tool", "ui"]),
            action: z.enum(["accept", "decline", "cancel"]),
          })
          .optional(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, questions, autoResolutionMs }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      validateQuestions(questions);
      const requested = workspaceStore.createUserInputRequest({
        workspaceSessionId: workspaceId,
        questions,
        autoResolutionMs,
      });

      const capabilities = server.server.getClientCapabilities();
      const supportsElicitation = Boolean(capabilities?.elicitation?.form);

      let record = requested;
      let delivery:
        | "elicitation_completed"
        | "elicitation_declined"
        | "elicitation_cancelled"
        | "pending_fallback" = "pending_fallback";

      if (supportsElicitation) {
        try {
          const elicitation = await server.server.elicitInput({
            mode: "form",
            message: "Please answer the following questions to continue.",
            requestedSchema: toElicitationSchema(questions),
          });

          if (elicitation.action === "accept" && elicitation.content) {
            record = workspaceStore.completeUserInput({
              workspaceSessionId: workspaceId,
              answers: answersFromElicitation(questions, elicitation.content),
              summary: summarizeAnswers(questions, elicitation.content),
              source: "elicitation",
            });
            delivery = "elicitation_completed";
          } else if (elicitation.action === "decline") {
            record = workspaceStore.cancelOrDeclineUserInput({
              workspaceSessionId: workspaceId,
              action: "decline",
              source: "elicitation",
            });
            delivery = "elicitation_declined";
          } else {
            record = workspaceStore.cancelOrDeclineUserInput({
              workspaceSessionId: workspaceId,
              action: "cancel",
              source: "elicitation",
            });
            delivery = "elicitation_cancelled";
          }
        } catch {
          record = requested;
          delivery = "pending_fallback";
        }
      }

      const content = [
        textBlock(
          delivery === "pending_fallback"
            ? `${formatUserInputPrompt(record.questions, record.autoResolutionMs)}\nReply with answers or use the card.`
            : formatUserInputRecordResult(record),
        ),
      ];

      logToolCall(config, {
        tool: "request_user_input",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          status: record.status,
          delivery,
          prompt: toStructuredUserInputRecord(record),
          response: record.response,
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_pending_user_input",
    {
      title: "Get pending user input",
      description:
        "Get the currently pending user-input request for a workspace, if one exists.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        result: z.string(),
        prompt: userInputPromptOutputSchema.nullable(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const pending = workspaceStore.getPendingUserInput(workspaceId);
      const content = [
        textBlock(
          pending
            ? formatUserInputPrompt(pending.questions, pending.autoResolutionMs)
            : "No pending user-input request for this workspace.",
        ),
      ];

      logToolCall(config, {
        tool: "get_pending_user_input",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          prompt: pending ? toStructuredUserInputRecord(pending) : null,
        },
      };
    },
  );

  registerAppTool(
    server,
    "answer_user_input",
    {
      title: "Answer user input",
      description:
        "Answer the currently pending user-input request for a workspace and complete the request lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        source: z.enum(["tool", "ui"]).optional(),
        text: z.string().optional(),
        answers: z.array(
          z.object({
            questionId: z.string(),
            label: z.string(),
          }),
        ).min(1),
      },
      outputSchema: {
        result: z.string(),
        prompt: userInputPromptOutputSchema,
        response: z.object({
          answers: z.array(userInputAnswerOutputSchema),
          summary: z.string(),
          source: z.enum(["elicitation", "tool", "ui"]),
          action: z.enum(["accept", "decline", "cancel"]),
        }),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, answers, text, source }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const pending = workspaceStore.getPendingUserInput(workspaceId);
      if (!pending) {
        const response = toolError("No pending user-input request exists for this workspace.");
        logFailedToolResponse(config, {
          tool: "answer_user_input",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }

      const submittedAnswers = text ? parseAnswerTextOrThrow(pending, text) : answers;
      validateSubmittedAnswers(pending, submittedAnswers);
      const summary = summarizeSubmittedAnswers(pending, submittedAnswers);
      const completed = workspaceStore.completeUserInput({
        workspaceSessionId: workspaceId,
        answers: submittedAnswers,
        summary,
        source: source ?? "tool",
      });
      const content = [textBlock("Answer recorded")];

      logToolCall(config, {
        tool: "answer_user_input",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: "answer_user_input",
          card: {
            workspaceId,
            status: completed.status,
            summary: {
              answered: completed.response?.answers.length ?? 0,
            },
            payload: {
              content,
            },
            userInput: toStructuredUserInputRecord(completed),
          },
        },
        structuredContent: {
          result: contentText(content),
          prompt: toStructuredUserInputRecord(completed),
          response: completed.response,
        },
      };
    },
  );

  registerAppTool(
    server,
    "list_user_input_history",
    {
      title: "List user input history",
      description:
        "List recent user-input requests and answers for a workspace.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        limit: z.number().int().positive().max(20).optional(),
      },
      outputSchema: {
        result: z.string(),
        history: z.array(userInputPromptOutputSchema),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, limit }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const history = workspaceStore.listUserInputHistory(workspaceId, limit);
      const content = [textBlock(history.length === 0 ? "No user-input history for this workspace." : history.map(formatUserInputRecordResult).join("\n\n"))];

      logToolCall(config, {
        tool: "list_user_input_history",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          history: history.map(toStructuredUserInputRecord),
        },
      };
    },
  );

  registerAppTool(
    server,
    "update_plan",
    {
      title: "Update plan",
      description:
        "Store or replace a workspace-scoped execution plan. Use this when the task benefits from a short checklist with pending, in-progress, and completed steps.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        explanation: z
          .string()
          .optional()
          .describe("Optional short explanation for this plan update."),
        plan: z
          .array(
            z.object({
              step: z.string().describe("Concrete plan step."),
              status: z.enum(["pending", "in_progress", "completed"]),
            }),
          )
          .min(1)
          .describe("Current workspace plan. At most one step may be in_progress."),
      },
      outputSchema: {
        result: z.string(),
        explanation: z.string().optional(),
        plan: z.array(
          z.object({
            step: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        ),
        updatedAt: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "plan"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, explanation, plan }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const collaboration = workspaceStore.getCollaborationMode(workspaceId);
      if (collaboration.mode === "plan") {
        const response = toolError("update_plan is unavailable while the workspace is in plan mode. Use request_user_input, repository exploration, and concrete planning instead.");
        logFailedToolResponse(config, {
          tool: "update_plan",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }

      validatePlanSteps(plan);
      const saved = workspaceStore.savePlan({
        workspaceSessionId: workspaceId,
        explanation,
        steps: plan,
      });
      const content = [textBlock(formatPlanResult(saved.steps, saved.explanation))];

      logToolCall(config, {
        tool: "update_plan",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          explanation: saved.explanation,
          plan: saved.steps,
          updatedAt: saved.updatedAt,
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_goal",
    {
      title: "Get goal",
      description:
        "Get the current workspace-scoped goal if one exists, including objective, status, and timestamps.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        result: z.string(),
        goal: z
          .object({
            objective: z.string(),
            status: z.enum(["active", "complete", "blocked"]),
            tokenBudget: z.number().int().positive().optional(),
            createdAt: z.string(),
            updatedAt: z.string(),
            timeUsedSeconds: z.number().int().nonnegative(),
            completedAt: z.string().optional(),
            blockedAt: z.string().optional(),
          })
          .nullable(),
      },
      ...toolWidgetDescriptorMeta(config, "goal"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const goal = workspaceStore.getGoal(workspaceId);
      const content = [textBlock(goal ? formatGoalResult(goal) : "No active or historical goal for this workspace.")];

      logToolCall(config, {
        tool: "get_goal",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          goal: goal
            ? {
                objective: goal.objective,
                status: goal.status,
                tokenBudget: goal.tokenBudget,
                createdAt: goal.createdAt,
                updatedAt: goal.updatedAt,
                timeUsedSeconds: goal.timeUsedSeconds,
                completedAt: goal.completedAt,
                blockedAt: goal.blockedAt,
              }
            : null,
        },
      };
    },
  );

  registerAppTool(
    server,
    "create_goal",
    {
      title: "Create goal",
      description:
        "Create a new workspace-scoped goal. Fails if an active goal already exists for that workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        objective: z.string().describe("Concrete objective to pursue."),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional positive token budget for the goal."),
      },
      outputSchema: {
        result: z.string(),
        goal: z.object({
          objective: z.string(),
          status: z.literal("active"),
          tokenBudget: z.number().int().positive().optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
          timeUsedSeconds: z.number().int().nonnegative(),
        }),
      },
      ...toolWidgetDescriptorMeta(config, "goal"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, objective, tokenBudget }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const goal = workspaceStore.saveGoal({
        workspaceSessionId: workspaceId,
        objective,
        tokenBudget,
      });
      const content = [textBlock(formatGoalResult(goal))];

      logToolCall(config, {
        tool: "create_goal",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          goal: {
            objective: goal.objective,
            status: goal.status,
            tokenBudget: goal.tokenBudget,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            timeUsedSeconds: goal.timeUsedSeconds,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "update_goal",
    {
      title: "Update goal",
      description:
        "Mark the current workspace-scoped goal complete or blocked.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        status: z.enum(["complete", "blocked"]),
      },
      outputSchema: {
        result: z.string(),
        goal: z.object({
          objective: z.string(),
          status: z.enum(["complete", "blocked"]),
          tokenBudget: z.number().int().positive().optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
          timeUsedSeconds: z.number().int().nonnegative(),
          completedAt: z.string().optional(),
          blockedAt: z.string().optional(),
        }),
      },
      ...toolWidgetDescriptorMeta(config, "goal"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, status }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const goal = workspaceStore.updateGoalStatus({
        workspaceSessionId: workspaceId,
        status,
      });
      const content = [textBlock(formatGoalResult(goal, status === "complete"))];

      logToolCall(config, {
        tool: "update_goal",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result: contentText(content),
          goal: {
            objective: goal.objective,
            status: goal.status,
            tokenBudget: goal.tokenBudget,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            timeUsedSeconds: goal.timeUsedSeconds,
            completedAt: goal.completedAt,
            blockedAt: goal.blockedAt,
          },
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
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
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
      const readPath = workspaces.resolveReadPath(workspace, input.path);
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
        ...contentStats(response.content),
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

  registerAppTool(
    server,
    "apply_workspace_patch",
    {
      title: "Apply workspace patch",
      description:
        `Apply a unified diff patch inside an open workspace. Use this for multi-file or batch file modifications instead of ${toolNames.shell}, shell redirection, heredocs, generated scripts, or ad-hoc write commands. All changed paths must stay inside the workspace root. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        patch: z
          .string()
          .describe("Unified diff patch containing diff --git file headers."),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
        files: z.array(z.string()),
      }),
      ...toolWidgetDescriptorMeta(config, "safe_operation"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        const result = await applyWorkspacePatch({ patch }, { root: workspace.root });
        const stats = countDiffStats(patch);
        const message = `Applied patch to ${result.files.length} file${result.files.length === 1 ? "" : "s"} (+${stats.additions} -${stats.removals}).`;
        const content = [textBlock(message)];

        logToolCall(config, {
          tool: "apply_workspace_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_workspace_patch",
            card: {
              workspaceId,
              summary: {
                files: result.files.length,
                ...stats,
              },
              payload: {
                patch,
                stdout: result.stdout,
                stderr: result.stderr,
              },
            },
          },
          structuredContent: {
            status: "applied" as const,
            files: result.files,
            result: contentText(content),
          },
        };
      } catch (error) {
        const response = toolError(error instanceof Error ? error.message : String(error));
        logFailedToolResponse(config, {
          tool: "apply_workspace_patch",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }
    },
  );

  registerAppTool(
    server,
    "git_push",
    {
      title: "Git push",
      description:
        "Push the current workspace git branch using structured arguments. Use this instead of running git push through the generic shell tool when the user explicitly asks to push.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        remote: z
          .string()
          .optional()
          .describe("Git remote name. Defaults to origin."),
        branch: z
          .string()
          .optional()
          .describe("Branch or refspec to push. Omit to use git's configured default push target."),
        setUpstream: z
          .boolean()
          .optional()
          .describe("When true, pass -u to set upstream for the branch."),
      },
      outputSchema: resultOutputSchema({
        remote: z.string(),
        branch: z.string().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "safe_operation"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspaceId, remote, branch, setUpstream }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        const result = await gitPush({ remote, branch, setUpstream }, { root: workspace.root });
        const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        const content = [textBlock(text || `Pushed to ${result.remote}${result.branch ? ` ${result.branch}` : ""}.`)];

        logToolCall(config, {
          tool: "git_push",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "git_push",
            card: {
              workspaceId,
              summary: {
                remote: result.remote,
                branch: result.branch,
              },
              payload: {
                stdout: result.stdout,
                stderr: result.stderr,
              },
            },
          },
          structuredContent: {
            remote: result.remote,
            branch: result.branch,
            result: contentText(content),
          },
        };
      } catch (error) {
        const response = toolError(error instanceof Error ? error.message : String(error));
        logFailedToolResponse(config, {
          tool: "git_push",
          workspaceId,
        }, response.content, startedAt);
        return response;
      }
    },
  );

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes in an open workspace since the last shown checkpoint or since the workspace was opened. After you create, edit, or overwrite files, call this once when the related file changes are complete so the user can inspect the combined diff.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown. Use workspace_open to compare against the initial open_workspace checkpoint."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, since, markReviewed }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: since ?? "last_shown",
          markReviewed: markReviewed ?? true,
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

  if (!config.minimalTools) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: config.toolNaming === "short" ? "Grep" : "Grep files",
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
          ...contentStats(response.content),
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
        title: config.toolNaming === "short" ? "Glob" : "Find files",
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
          ...contentStats(response.content),
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
        title: config.toolNaming === "short" ? "Ls" : "List directory",
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

        const summary = contentStats(response.content);
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

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: config.toolNaming === "short" ? "Bash" : "Run shell",
      description: config.minimalTools
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
      const shellPolicy = validateShellCommand(config.shellMode, input.command);
      if (!shellPolicy.allowed) {
        const response = toolError(shellPolicy.reason ?? "Shell command blocked.");
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }
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
        ...contentStats(response.content),
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

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();

  if (config.logging.trustProxy) {
    // DevSpace sits behind exactly one local reverse proxy: Nginx.
    // Do not trust arbitrary forwarded chains from public clients.
    app.set("trust proxy", 1);
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

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(createOAuthMetadata({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      scopesSupported: config.oauth.scopes,
    }));
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
    res.json({ ok: true, name: "devspace" });
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
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(config, workspaces, reviewCheckpoints, workspaceStore);
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

  return { app, config };
}

function validatePlanSteps(steps: WorkspacePlanStep[]): void {
  const inProgressCount = steps.filter((step) => step.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new Error("A plan may have at most one in_progress step.");
  }
}

function validateQuestions(questions: WorkspaceQuestion[]): void {
  for (const question of questions) {
    if (question.options.length < 2 || question.options.length > 3) {
      throw new Error("Each question must have 2 or 3 options.");
    }
  }
}

function validateSubmittedAnswers(
  pending: WorkspaceUserInputRecord,
  answers: WorkspaceUserInputAnswer[],
): void {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer.label]));
  if (answerMap.size !== pending.questions.length) {
    throw new Error("Each pending question must have exactly one submitted answer.");
  }

  for (const question of pending.questions) {
    const selected = answerMap.get(question.id);
    if (!selected) {
      throw new Error(`Missing answer for question ${question.id}.`);
    }
    if (!question.options.some((option) => option.label === selected)) {
      throw new Error(`Invalid answer label for question ${question.id}: ${selected}`);
    }
  }
}

function formatPlanResult(steps: WorkspacePlanStep[], explanation: string | undefined): string {
  const summary = steps
    .map((step) => `${step.status === "completed" ? "[done]" : step.status === "in_progress" ? "[doing]" : "[todo]"} ${step.step}`)
    .join("\n");
  return explanation ? `${explanation}\n${summary}` : summary;
}

function toElicitationSchema(questions: WorkspaceQuestion[]): {
  type: "object";
  properties: Record<
    string,
    {
      type: "string";
      title: string;
      description: string;
      oneOf: Array<{
        const: string;
        title: string;
        description: string;
      }>;
    }
  >;
  required: string[];
} {
  return {
    type: "object",
    properties: Object.fromEntries(
      questions.map((question) => [
        question.id,
        {
          type: "string",
          title: question.header,
          description: question.question,
          oneOf: question.options.map((option) => ({
            const: option.label,
            title: option.label,
            description: option.description,
          })),
        },
      ]),
    ),
    required: questions.map((question) => question.id),
  };
}

function answersFromElicitation(
  questions: WorkspaceQuestion[],
  content: Record<string, string | number | boolean | string[]>,
): WorkspaceUserInputAnswer[] {
  return questions.map((question) => ({
    questionId: question.id,
    label: String(content[question.id] ?? ""),
  }));
}

function summarizeAnswers(
  questions: WorkspaceQuestion[],
  content: Record<string, string | number | boolean | string[]>,
): string {
  return questions
    .map((question) => `${question.header}: ${String(content[question.id] ?? "")}`)
    .join("\n");
}

function summarizeSubmittedAnswers(
  pending: WorkspaceUserInputRecord,
  answers: WorkspaceUserInputAnswer[],
): string {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer.label]));
  return pending.questions
    .map((question) => `${question.header}: ${answerMap.get(question.id) ?? ""}`)
    .join("\n");
}

function formatGoalResult(goal: {
  objective: string;
  status: "active" | "complete" | "blocked";
  tokenBudget?: number;
  createdAt: string;
  updatedAt: string;
  timeUsedSeconds: number;
  completedAt?: string;
  blockedAt?: string;
}, includeCompletionNote = false): string {
  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    goal.tokenBudget !== undefined ? `Token budget: ${goal.tokenBudget}` : undefined,
    `Time used seconds: ${goal.timeUsedSeconds}`,
    goal.completedAt ? `Completed: ${goal.completedAt}` : undefined,
    goal.blockedAt ? `Blocked: ${goal.blockedAt}` : undefined,
    includeCompletionNote ? "Report the final budget and usage summary back to the user if the host tracks it." : undefined,
  ];

  return lines.filter(Boolean).join("\n");
}

function formatUserInputRecordResult(record: WorkspaceUserInputRecord): string {
  const lines = [
    `Status: ${record.status}`,
    record.response?.summary,
    record.deliveryMode ? `Delivery: ${record.deliveryMode}` : undefined,
    record.answeredAt ? `Answered: ${record.answeredAt}` : undefined,
  ];

  if (record.status === "pending") {
    lines.unshift(formatUserInputPrompt(record.questions, record.autoResolutionMs));
  }

  return lines.filter(Boolean).join("\n");
}

function formatUserInputPrompt(
  questions: WorkspaceQuestion[],
  autoResolutionMs: number | undefined,
): string {
  const lines = questions.flatMap((question) => [
    `${question.header}: ${question.question}`,
    ...question.options.map((option) => `- ${option.label}: ${option.description}`),
  ]);
  if (autoResolutionMs !== undefined) {
    lines.push(`Auto resolution: ${autoResolutionMs}ms`);
  }

  return lines.join("\n");
}

function toStructuredUserInputRecord(record: WorkspaceUserInputRecord): {
  questions: WorkspaceQuestion[];
  autoResolutionMs?: number;
  status: "pending" | "completed" | "declined" | "cancelled";
  deliveryMode?: "elicitation" | "tool" | "ui";
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
  response?: {
    answers: WorkspaceUserInputAnswer[];
    summary: string;
    source: "elicitation" | "tool" | "ui";
    action: "accept" | "decline" | "cancel";
  };
} {
  return {
    questions: record.questions,
    autoResolutionMs: record.autoResolutionMs,
    status: record.status,
    deliveryMode: record.deliveryMode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    answeredAt: record.answeredAt,
    response: record.response,
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config } = createServer();
  app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });
}
