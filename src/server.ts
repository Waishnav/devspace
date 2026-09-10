import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { NextFunction, Request, Response } from "express";
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
import { WorkspaceActivityJournal } from "./workspace-activity-journal.js";
import { WorkspaceActivityService } from "./workspace-activity-service.js";
import {
  listWorkspaceRefs,
  readWorkspaceDiff,
  type WorkspaceDiffScope,
} from "./workspace-diff.js";
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
const WORKSPACE_INSPECTOR_MANIFEST_ENTRY = "workspace-inspector.html";

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
  imports?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, and ${toolNames.read} permits files within advertised skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in available_agents_files, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspace_id. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspace_id is rejected.`;

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
    ip: requestIp(req, config.logging.trustProxy),
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

function getWorkspaceAppManifestEntry(
  entryName = WORKSPACE_APP_MANIFEST_ENTRY,
): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[entryName];

  if (!entry?.file) {
    throw new Error(`Missing ${entryName} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppStylesheets(entryName: string): string[] {
  const manifest = readWorkspaceAppManifest();
  const stylesheets = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const entry = manifest[name];
    if (!entry) return;
    for (const stylesheet of entry.css ?? []) stylesheets.add(stylesheet);
    for (const imported of entry.imports ?? []) visit(imported);
  };

  visit(entryName);
  return [...stylesheets];
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = workspaceAppStylesheets(WORKSPACE_APP_MANIFEST_ENTRY)
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

function workspaceInspectorHtml(input: {
  workspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
}): string {
  const entry = getWorkspaceAppManifestEntry(WORKSPACE_INSPECTOR_MANIFEST_ENTRY);
  const baseUrl = "/mcp-app-assets";
  const stylesheets = workspaceAppStylesheets(WORKSPACE_INSPECTOR_MANIFEST_ENTRY)
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");
  const bootstrap = JSON.stringify(input).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace Inspector</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app"></main>
    <script id="devspace-workspace-bootstrap" type="application/json">${bootstrap}</script>
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
  const candidates = [
    entry.file,
    ...workspaceAppStylesheets(WORKSPACE_APP_MANIFEST_ENTRY),
  ].map(
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
  workspaceActivityJournal?: WorkspaceActivityJournal,
  workspaceActivityService?: WorkspaceActivityService,
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
    workspaceActivityJournal,
    workspaceActivityService,
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
  workspaceActivityJournal?: WorkspaceActivityJournal,
  workspaceActivityService?: WorkspaceActivityService,
): void {
  const registrationTarget = trackToolActivity || workspaceActivityJournal
    ? withObservedToolHandlers(server, { trackToolActivity, workspaceActivityJournal })
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
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; files within advertised skill directories are readable."
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
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
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

  if (config.uiEnabled && workspaceActivityService) {
    registerWorkspaceInspectorTools(
      server,
      workspaces,
      reviewCheckpoints,
      workspaceActivityService,
    );
  }
}

function registerWorkspaceInspectorTools(
  server: McpRegistrationTarget,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  activity: WorkspaceActivityService,
): void {
  const appOnlyMeta = {
    _meta: {
      ui: {
        visibility: ["app"] as const,
      },
    },
  };

  registerAppTool(
    server,
    "get_workspace_activity",
    {
      title: "Get workspace activity",
      description: "Read recent persisted tool activity for a workspace.",
      inputSchema: {
        workspace_id: z.string(),
        review_ref: z.string().optional(),
      },
      outputSchema: {
        groups: z.array(z.object({
          id: z.string(),
          kind: z.enum(["review", "inferred"]),
          started_at: z.string(),
          completed_at: z.string().optional(),
          review_ref: z.string().optional(),
          calls: z.array(z.object({
            id: z.number().int(),
            tool_name: z.string(),
            started_at: z.string(),
            completed_at: z.string().optional(),
            duration_ms: z.number().int().optional(),
          })),
        })),
      },
      ...appOnlyMeta,
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, review_ref }) => {
      await workspaces.getWorkspace(workspace_id);
      const output = workspaceActivityOutput(activity, workspace_id, review_ref);
      return {
        content: [textBlock(`Loaded ${output.groups.length} activity groups.`)],
        structuredContent: output,
      };
    },
  );

  registerAppTool(
    server,
    "get_workspace_tool_call",
    {
      title: "Get workspace tool call",
      description: "Read the raw persisted input and result for one workspace tool call.",
      inputSchema: {
        workspace_id: z.string(),
        call_id: z.number().int().positive(),
      },
      outputSchema: {
        call: z.object({
          id: z.number().int(),
          tool_name: z.string(),
          arguments: z.unknown(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
          started_at: z.string(),
          completed_at: z.string().optional(),
          duration_ms: z.number().int().optional(),
          review_ref: z.string().optional(),
        }),
      },
      ...appOnlyMeta,
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, call_id }) => {
      await workspaces.getWorkspace(workspace_id);
      const call = activity.getToolCall(workspace_id, call_id);
      if (!call) throw new Error(`Unknown tool call ${call_id} for workspace ${workspace_id}.`);
      return {
        content: [textBlock(`Loaded ${call.toolName} tool call.`)],
        structuredContent: { call: workspaceToolCallOutput(call) },
      };
    },
  );

  registerAppTool(
    server,
    "get_workspace_diff",
    {
      title: "Get workspace diff",
      description: "Read a workspace diff for a review, working tree, branch, or exact ref comparison.",
      inputSchema: {
        workspace_id: z.string(),
        scope: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("review"), review_ref: z.string() }),
          z.object({ kind: z.literal("working-tree") }),
          z.object({ kind: z.literal("branch"), base_ref: z.string().optional() }),
          z.object({ kind: z.literal("compare"), from_ref: z.string(), to_ref: z.string() }),
        ]),
      },
      outputSchema: {
        scope: z.unknown(),
        summary: z.object({
          files: z.number().int(),
          additions: z.number().int(),
          removals: z.number().int(),
        }),
        files: z.array(z.unknown()),
        patch: z.string(),
      },
      ...appOnlyMeta,
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, scope }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const internalScope = workspaceDiffScopeFromInput(scope);
      const diff = await readWorkspaceDiff(workspace, reviewCheckpoints, internalScope);
      return {
        content: [textBlock(`Loaded workspace diff for ${diff.scope.kind}.`)],
        structuredContent: workspaceDiffOutput(diff),
      };
    },
  );

  registerAppTool(
    server,
    "get_workspace_refs",
    {
      title: "Get workspace refs",
      description: "List Git refs available for workspace comparisons.",
      inputSchema: { workspace_id: z.string() },
      outputSchema: {
        current_ref: z.string().optional(),
        default_base_ref: z.string().optional(),
        refs: z.array(z.string()),
      },
      ...appOnlyMeta,
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const refs = await listWorkspaceRefs(workspace);
      return {
        content: [textBlock(`Loaded ${refs.refs.length} Git refs.`)],
        structuredContent: workspaceRefsOutput(refs),
      };
    },
  );
}

function workspaceActivityOutput(
  activity: WorkspaceActivityService,
  workspaceId: string,
  reviewRef?: string,
): {
  groups: Array<{
    id: string;
    kind: "review" | "inferred";
    started_at: string;
    completed_at?: string;
    review_ref?: string;
    calls: Array<{
      id: number;
      tool_name: string;
      started_at: string;
      completed_at?: string;
      duration_ms?: number;
    }>;
  }>;
} {
  const groups = reviewRef
    ? [activity.findReviewGroup(workspaceId, reviewRef)].filter(
        (group): group is NonNullable<typeof group> => Boolean(group),
      )
    : activity.listActivity(workspaceId).groups;
  return {
    groups: groups.map((group) => ({
      id: group.id,
      kind: group.kind,
      started_at: group.startedAt,
      ...(group.completedAt ? { completed_at: group.completedAt } : {}),
      ...(group.reviewRef ? { review_ref: group.reviewRef } : {}),
      calls: group.calls.map((call) => ({
        id: call.id,
        tool_name: call.toolName,
        started_at: call.startedAt,
        ...(call.completedAt ? { completed_at: call.completedAt } : {}),
        ...(call.durationMs !== undefined ? { duration_ms: call.durationMs } : {}),
      })),
    })),
  };
}

function workspaceToolCallOutput(call: NonNullable<ReturnType<WorkspaceActivityService["getToolCall"]>>): {
  id: number;
  tool_name: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  review_ref?: string;
} {
  return {
    id: call.id,
    tool_name: call.toolName,
    arguments: call.arguments,
    ...(call.result !== undefined ? { result: call.result } : {}),
    ...(call.error !== undefined ? { error: call.error } : {}),
    started_at: call.startedAt,
    ...(call.completedAt ? { completed_at: call.completedAt } : {}),
    ...(call.durationMs !== undefined ? { duration_ms: call.durationMs } : {}),
    ...(call.reviewRef ? { review_ref: call.reviewRef } : {}),
  };
}

function workspaceDiffOutput(diff: Awaited<ReturnType<typeof readWorkspaceDiff>>): {
  scope: Record<string, unknown>;
  summary: typeof diff.summary;
  files: typeof diff.files;
  patch: string;
} {
  return {
    scope: workspaceDiffScopeToOutput(diff.scope),
    summary: diff.summary,
    files: diff.files,
    patch: diff.patch,
  };
}

function workspaceRefsOutput(refs: Awaited<ReturnType<typeof listWorkspaceRefs>>): {
  current_ref?: string;
  default_base_ref?: string;
  refs: string[];
} {
  return {
    ...(refs.currentRef ? { current_ref: refs.currentRef } : {}),
    ...(refs.defaultBaseRef ? { default_base_ref: refs.defaultBaseRef } : {}),
    refs: refs.refs,
  };
}

function workspaceDiffScopeFromInput(input: {
  kind: "review" | "working-tree" | "branch" | "compare";
  review_ref?: string;
  base_ref?: string;
  from_ref?: string;
  to_ref?: string;
}): WorkspaceDiffScope {
  switch (input.kind) {
    case "review":
      if (!input.review_ref) throw new Error("review_ref is required for review diffs.");
      return { kind: "review", reviewRef: input.review_ref };
    case "working-tree":
      return { kind: "working-tree" };
    case "branch":
      return { kind: "branch", ...(input.base_ref ? { baseRef: input.base_ref } : {}) };
    case "compare":
      if (!input.from_ref || !input.to_ref) throw new Error("from_ref and to_ref are required.");
      return { kind: "compare", fromRef: input.from_ref, toRef: input.to_ref };
  }
}

function workspaceDiffScopeToOutput(scope: WorkspaceDiffScope): Record<string, unknown> {
  switch (scope.kind) {
    case "review":
      return { kind: scope.kind, review_ref: scope.reviewRef };
    case "working-tree":
      return { kind: scope.kind };
    case "branch":
      return { kind: scope.kind, base_ref: scope.baseRef };
    case "compare":
      return { kind: scope.kind, from_ref: scope.fromRef, to_ref: scope.toRef };
  }
}

function workspaceDiffScopeFromQuery(query: Request["query"]): WorkspaceDiffScope {
  switch (query.scope) {
    case "review":
      if (typeof query.review !== "string" || !query.review) {
        throw new Error("review is required for review diffs.");
      }
      return { kind: "review", reviewRef: query.review };
    case "working-tree":
      return { kind: "working-tree" };
    case "branch":
      return {
        kind: "branch",
        ...(typeof query.base === "string" && query.base ? { baseRef: query.base } : {}),
      };
    case "compare":
      if (
        typeof query.from !== "string"
        || typeof query.to !== "string"
        || !query.from
        || !query.to
      ) {
        throw new Error("from and to are required for ref comparisons.");
      }
      return { kind: "compare", fromRef: query.from, toRef: query.to };
    default:
      throw new Error("scope must be review, working-tree, branch, or compare.");
  }
}

export function isLocalInspectorHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function requireLocalInspectorHost(req: Request, res: Response, next: NextFunction): void {
  if (isLocalInspectorHost(req.headers.host)) {
    next();
    return;
  }
  res.status(403).json({ error: "Workspace inspector is only available on a loopback host." });
}

function sendInspectorHttpError(res: Response, error: unknown, status: number): void {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

function requiredRouteParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  throw new Error(`Missing route parameter: ${name}`);
}

function withObservedToolHandlers(
  server: McpRegistrationTarget,
  options: {
    trackToolActivity?: TrackToolActivity;
    workspaceActivityJournal?: WorkspaceActivityJournal;
  },
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const toolName = args[0] as string;
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        (...handlerArgs: unknown[]) => {
          const operation = () => Promise.resolve(handler(...handlerArgs));
          const observedOperation = options.workspaceActivityJournal
            ? () => options.workspaceActivityJournal!.capture({
                toolName,
                arguments: handlerArgs[0],
                extra: (handlerArgs[1] ?? {}) as Record<string, unknown>,
                operation,
              })
            : operation;
          return options.trackToolActivity
            ? options.trackToolActivity(observedOperation)
            : observedOperation();
        },
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
    : Array.from(new Set([config.host, ...config.allowedHosts, "localhost", "127.0.0.1", "[::1]"]));
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
  const workspaceActivityJournal = new WorkspaceActivityJournal(config.stateDir, (error) => {
    logEvent(config.logging, "warn", "workspace_activity_journal_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const workspaceActivityService = new WorkspaceActivityService(config.stateDir);
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
      workspaceActivityJournal,
      workspaceActivityService,
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
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = toNodeHandler(mcpHandler, {
    onerror: logMcpHandlerError,
  });

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

  if (config.uiEnabled) {
    app.use("/ws", requireLocalInspectorHost);
    app.use("/api/workspaces", requireLocalInspectorHost);

    app.get("/ws/:workspaceId", (req, res) => {
      const workspaceId = requiredRouteParam(req, "workspaceId");
      const queryIndex = req.originalUrl.indexOf("?");
      const search = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
      res.redirect(302, `/ws/${encodeURIComponent(workspaceId)}/activity${search}`);
    });

    app.get(["/ws/:workspaceId/activity", "/ws/:workspaceId/changes"], async (req, res) => {
      try {
        const workspace = await workspaces.getWorkspace(requiredRouteParam(req, "workspaceId"));
        res.type("html").send(workspaceInspectorHtml({
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
        }));
      } catch (error) {
        sendInspectorHttpError(res, error, 404);
      }
    });

    app.get("/api/workspaces/:workspaceId/activity", async (req, res) => {
      try {
        const workspaceId = requiredRouteParam(req, "workspaceId");
        await workspaces.getWorkspace(workspaceId);
        const reviewRef = typeof req.query.review === "string" ? req.query.review : undefined;
        res.json(workspaceActivityOutput(workspaceActivityService, workspaceId, reviewRef));
      } catch (error) {
        sendInspectorHttpError(res, error, 404);
      }
    });

    app.get("/api/workspaces/:workspaceId/tool-calls/:callId", async (req, res) => {
      try {
        const workspaceId = requiredRouteParam(req, "workspaceId");
        await workspaces.getWorkspace(workspaceId);
        const callId = Number(requiredRouteParam(req, "callId"));
        if (!Number.isSafeInteger(callId) || callId <= 0) {
          res.status(400).json({ error: "callId must be a positive integer." });
          return;
        }
        const call = workspaceActivityService.getToolCall(workspaceId, callId);
        if (!call) {
          res.status(404).json({ error: `Unknown tool call ${callId} for workspace ${workspaceId}.` });
          return;
        }
        res.json({ call: workspaceToolCallOutput(call) });
      } catch (error) {
        sendInspectorHttpError(res, error, 404);
      }
    });

    app.get("/api/workspaces/:workspaceId/diff", async (req, res) => {
      try {
        const workspace = await workspaces.getWorkspace(requiredRouteParam(req, "workspaceId"));
        const scope = workspaceDiffScopeFromQuery(req.query);
        const diff = await readWorkspaceDiff(workspace, reviewCheckpoints, scope);
        res.json(workspaceDiffOutput(diff));
      } catch (error) {
        sendInspectorHttpError(res, error, 400);
      }
    });

    app.get("/api/workspaces/:workspaceId/refs", async (req, res) => {
      try {
        const workspace = await workspaces.getWorkspace(requiredRouteParam(req, "workspaceId"));
        res.json(workspaceRefsOutput(await listWorkspaceRefs(workspace)));
      } catch (error) {
        sendInspectorHttpError(res, error, 404);
      }
    });
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

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
        workspaceActivityJournal.close();
        workspaceActivityService.close();
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
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
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
