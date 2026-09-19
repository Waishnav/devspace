import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toWebRequest } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

function mcpServerInfo() {
  return {
    name: "devspace",
    title: "DevSpace",
    version: DEVSPACE_VERSION,
    description:
      "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspace_id.",
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

// Keep the origin socket open longer than the short default so a reverse
// proxy or tunnel cannot reuse a socket after Node has already closed it.
export const DEVSPACE_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEVSPACE_HTTP_HEADERS_TIMEOUT_MS =
  DEVSPACE_HTTP_KEEP_ALIVE_TIMEOUT_MS + 5_000;

export function configureHttpServer(httpServer: HttpServer): void {
  httpServer.keepAliveTimeout = DEVSPACE_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = DEVSPACE_HTTP_HEADERS_TIMEOUT_MS;
}

type ExpressTrustProxySetting = false | true | "loopback";

function expressTrustProxySetting(config: ServerConfig): ExpressTrustProxySetting {
  if (config.logging.trustProxy) return true;
  if (["localhost", "127.0.0.1", "::1"].includes(config.host)) return "loopback";
  return false;
}

function formatTrustProxySetting(setting: ExpressTrustProxySetting): string {
  if (setting === "loopback") return "loopback (automatic)";
  return setting ? "enabled (configured)" : "disabled";
}

function isLongLivedMcpRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as { method?: unknown }).method === "subscriptions/listen";
}

function rpcRequestLogFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const candidate = body as { id?: unknown; method?: unknown };
  return {
    rpcId: candidate.id,
    rpcIdType: typeof candidate.id,
    rpcMethod: candidate.method,
  };
}

const DEVSPACE_MCP_HANDLER_TIMEOUT_MS = 20_000;

function createReliableMcpNodeHandler(
  handler: ReturnType<typeof createMcpHandler>,
  onerror: (error: Error) => void,
) {
  return async (req: Request, res: Response, parsedBody: unknown): Promise<void> => {
    let finished = false;
    const abort = new AbortController();
    const handleClose = () => {
      if (!finished) abort.abort();
    };
    res.on("close", handleClose);

    try {
      const webRequest = await toWebRequest(req, parsedBody, { signal: abort.signal });
      const response = await Promise.race([
        handler.fetch(webRequest, {
          ...(req.auth !== undefined ? { authInfo: req.auth } : {}),
          ...(parsedBody !== undefined ? { parsedBody } : {}),
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`MCP handler timed out after ${DEVSPACE_MCP_HANDLER_TIMEOUT_MS}ms`));
          }, DEVSPACE_MCP_HANDLER_TIMEOUT_MS);
          timer.unref?.();
          abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        }),
      ]);
      const headers: Record<string, string> = {};
      for (const [name, value] of response.headers) headers[name] = value;

      if (response.body === null) {
        res.writeHead(response.status, headers);
        finished = true;
        res.end();
        return;
      }

      if (isLongLivedMcpRequest(parsedBody)) {
        res.writeHead(response.status, headers);
        for await (const chunk of response.body) {
          if (abort.signal.aborted) break;
          if (!res.write(chunk)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
        finished = true;
        res.end();
        return;
      }

      // Finite MCP responses are buffered before writing them to Node. This
      // gives the client an explicit Content-Length and prevents a stream
      // error from turning into a misleading HTTP 200 with a truncated body.
      const body = Buffer.from(await response.arrayBuffer());
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.byteLength);
      res.writeHead(response.status, headers);
      finished = true;
      res.end(body);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      try {
        onerror(normalized);
      } catch {
        // Logging must not mask the transport error.
      }
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else if (!res.destroyed) {
        res.destroy(normalized);
      }
    } finally {
      res.off("close", handleClose);
    }
  };
}

type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user provides an attached or generated file that needs to be added to the workspace, pass the provided file directly to download_artifact with the existing workspace_id and a suitable relative destination path. Do not reconstruct attached files manually."
      : "";
  const showChangesInstruction =
    " If files are modified, call show_changes once after the final related change and before the final response.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches one, use ${toolNames.read} with the returned skill path before proceeding. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in available_agents_files, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Call ${toolNames.openWorkspace} when starting work in a project folder or isolated worktree without a usable workspace_id, then reuse the returned workspace_id for subsequent operations in that workspace.`;

  return `${common} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
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
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
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
    ip: requestIp(req, expressTrustProxySetting(config) !== false),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
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

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    mcpServerInfo(),
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );

  registerMcpSurface(
    server,
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    trackToolActivity,
  );
  return server;
}

function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
): void {
  const registrationTarget = trackToolActivity
    ? withTrackedToolHandlers(server, trackToolActivity)
    : server;
  const toolSurface = getToolSurface(config.toolMode);

  registerAppResource(
    registrationTarget,
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
    registrationTarget,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspace_id exists for it. During continued work, reuse the existing workspace_id instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspace_id: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        source_root: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            base_ref: z.string(),
            base_sha: z.string(),
            dirty_source: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agents_files: z.array(workspaceAgentsFileOutputSchema).optional(),
        available_agents_files: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agent_providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skill_diagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, base_ref }, { _meta }) => {
      const startedAt = performance.now();
      const baseRef = base_ref;
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) },
      );
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const preloadSubagents = config.subagents.enabled
        && config.subagents.instructions === "preload";
      const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
      const preloadedSubagentInstructions = preloadSubagents && subagentsSkill
        ? readFileSync(subagentsSkill.filePath, "utf8")
        : undefined;
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file.";
      const workspaceInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspace_id.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspace_id for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const instruction = preloadedSubagentInstructions && includeBootstrapContext
        ? [
            workspaceInstruction,
            "Subagent workflow instructions:",
            preloadedSubagentInstructions,
          ].join("\n\n")
        : workspaceInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
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
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
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
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspace_id: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          source_root: workspace.sourceRoot,
          worktree: workspace.worktree
            ? {
                path: workspace.worktree.path,
                base_ref: workspace.worktree.baseRef,
                base_sha: workspace.worktree.baseSha,
                dirty_source: workspace.worktree.dirtySource,
                detached: workspace.worktree.detached,
                managed: workspace.worktree.managed,
              }
            : undefined,
          review,
          ...(includeBootstrapContext
            ? {
                agents_files: loadedAgentsFiles,
                available_agents_files: availableAgentsFileOutputs,
                skills: visibleSkills,
                agent_providers: visibleAgentProviders,
                agents: visibleAgents,
                skill_diagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  registrationTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read all or part of a file in a workspace.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read the returned skill path before proceeding."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspace_id: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path relative to the workspace root, or a skill path returned by open_workspace."
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
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = await workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        { cwd: workspace.root },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  toolSurface.register({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
  });

  registerAppTool(
    registrationTarget,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspace_id: z.string(),
        review_ref: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
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
          workspace_id: workspaceId,
          review_ref: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(registrationTarget, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  trackToolActivity: TrackToolActivity,
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        (...handlerArgs: unknown[]) => trackToolActivity(
          () => Promise.resolve(handler(...handlerArgs)),
        ),
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
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
  const toolActivities = new ToolActivityTracker();
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const modernToolSurface = getToolSurface(config.toolMode);
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    registerMcpSurface(
      target,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      toolActivities.track,
    );
  });
  const logMcpHandlerError = (error: Error) => logEvent(
    config.logging,
    "error",
    "mcp_handler_error",
    modernMcpAdapterErrorLogFields(error),
  );
  const mcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: serverInstructions(config, modernToolSurface) },
    );
    bindModernMcpSurface(adapter.registrationTarget);
    return adapter.server;
  }, {
    legacy: "stateless",
    responseMode: "json",
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = createReliableMcpNodeHandler(mcpHandler, logMcpHandlerError);

  app.set("trust proxy", expressTrustProxySetting(config));

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const path = requestPath(req);
    const shouldLogRequest = config.logging.requests
      && (config.logging.assets || !path.startsWith("/mcp-app-assets"));
    let finished = false;
    res.locals.requestId = requestId;

    if (shouldLogRequest) {
      logEvent(config.logging, "debug", "http_request_start", {
        requestId,
        method: req.method,
        path,
        ...requestLogFields(req, config),
      });
    }

    res.on("finish", () => {
      finished = true;
      if (!shouldLogRequest) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    res.on("close", () => {
      if (finished || !shouldLogRequest) return;
      logEvent(config.logging, "warn", "http_request_aborted", {
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
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", bearerAuth, async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
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
      protocolVersion: req.header("mcp-protocol-version"),
      mcpMethod: req.header("mcp-method"),
      mcpName: req.header("mcp-name"),
      ...rpcRequestLogFields(req.body),
    });

    try {
      await mcpNodeHandler(req, res, req.body);
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
        try {
          await mcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await toolActivities.waitForIdle();
        processSessions.shutdown();
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
    console.log(`trust proxy: ${formatTrustProxySetting(expressTrustProxySetting(config))}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });
  configureHttpServer(httpServer);

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
