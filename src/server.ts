import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
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
  sessionIdPrefix,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { isPathInsideRoot } from "./roots.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  formatAgentsPath,
  WorkspaceRegistry,
  type WorkspaceContext,
} from "./workspaces.js";
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

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
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
      ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns skills and a task matches one, use ${toolNames.read} to read that skill's path before proceeding. Project skill paths are relative to the current workspace root. Global skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agents = `Follow loaded instructions returned under instructions.global and instructions.project.loaded. Before working under a path listed in instructions.project.available, use ${toolNames.read} to inspect that instruction file and follow it. Project instruction paths are relative to the current workspace root. `;
  const common = `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Treat instructions, skills, agent profiles, and provider information returned by ${toolNames.openWorkspace}, plus instructions later read from advertised nested instruction files or SKILL.md files, as durable operating context and preserve them when summarizing or compacting conversation state. Later ${toolNames.openWorkspace} results may omit unchanged global or project scopes; an omitted scope remains unchanged and must continue to be followed. When a scope is returned again, replace the retained snapshot for that scope with the new value. If project instructions are returned again, treat previously read nested instruction files from that scope as stale and reread them when relevant. If a skills scope is returned again, reread a matching SKILL.md before relying on instructions previously read from that skill.`;

  return `${common} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
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

const workspaceInstructionsOutputSchema = z.object({
  global: z.array(workspaceAgentsFileOutputSchema).optional(),
  project: z.object({
    loaded: z.array(workspaceAgentsFileOutputSchema),
    available: z.array(workspaceAvailableAgentsFileOutputSchema),
  }).optional(),
});

const workspaceSkillsOutputSchema = z.object({
  global: z.array(workspaceSkillOutputSchema).optional(),
  project: z.array(workspaceSkillOutputSchema).optional(),
});

const workspaceAgentsOutputSchema = z.object({
  profiles: z.object({
    global: z.array(workspaceLocalAgentOutputSchema).optional(),
    project: z.array(workspaceLocalAgentOutputSchema).optional(),
  }).optional(),
  providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
});

function formatWorkspaceResourcePath(path: string, workspaceRoot: string): string {
  return isPathInsideRoot(path, workspaceRoot)
    ? formatAgentsPath(path, workspaceRoot)
    : formatPathForPrompt(path);
}

function scopedInstructions(
  loaded: Array<{ path: string; content: string }>,
  available: Array<{ path: string }>,
  workspaceRoot: string,
): {
  global: Array<{ path: string; content: string }>;
  project: {
    loaded: Array<{ path: string; content: string }>;
    available: Array<{ path: string }>;
  };
} {
  const global = loaded
    .filter((file) => !isPathInsideRoot(file.path, workspaceRoot))
    .map((file) => ({
      path: formatWorkspaceResourcePath(file.path, workspaceRoot),
      content: file.content,
    }));
  const projectLoaded = loaded
    .filter((file) => isPathInsideRoot(file.path, workspaceRoot))
    .map((file) => ({
      path: formatWorkspaceResourcePath(file.path, workspaceRoot),
      content: file.content,
    }));
  const projectAvailable = available.map((file) => ({
    path: formatWorkspaceResourcePath(file.path, workspaceRoot),
  }));

  return {
    global,
    project: {
      loaded: projectLoaded,
      available: projectAvailable,
    },
  };
}

function scopedSkills(
  skills: Array<{
    name: string;
    description: string;
    path: string;
    filePath?: string;
    scope: "global" | "project";
  }>,
): {
  global: Array<{ name: string; description: string; path: string }>;
  project: Array<{ name: string; description: string; path: string }>;
} {
  const summarize = (scope: "global" | "project") => skills
    .filter((skill) => skill.scope === scope)
    .map(({ scope: _scope, filePath: _filePath, ...skill }) => skill);
  const global = summarize("global");
  const project = summarize("project");
  return { global, project };
}

function scopedAgentCatalog(
  profiles: Array<{
    name: string;
    description: string;
    provider: string;
    scope: "global" | "project";
    model?: string;
    effort?: string;
  }>,
  providers: Array<{
    id: string;
    model?: string;
    effort?: string;
    note?: string;
  }>,
): {
  profiles: {
    global: Array<{ name: string; description: string; provider: string; model?: string; effort?: string }>;
    project: Array<{ name: string; description: string; provider: string; model?: string; effort?: string }>;
  };
  providers: Array<{ id: string; model?: string; effort?: string; note?: string }>;
} {
  const summarize = (scope: "global" | "project") => profiles
    .filter((profile) => profile.scope === scope)
    .map(({ scope: _scope, ...profile }) => profile);
  const global = summarize("global");
  const project = summarize("project");
  return {
    profiles: { global, project },
    providers,
  };
}

interface WorkspaceContextSnapshots {
  instructions: ReturnType<typeof scopedInstructions>;
  skills: ReturnType<typeof scopedSkills>;
  agents: ReturnType<typeof scopedAgentCatalog>;
}

interface WorkspaceContextFingerprintInputs {
  projectInstructions: unknown;
  globalSkills: unknown;
  projectSkills: unknown;
}

function conversationContextOutput(
  workspaces: WorkspaceRegistry,
  context: WorkspaceContext,
  snapshots: WorkspaceContextSnapshots,
  fingerprintInputs: WorkspaceContextFingerprintInputs,
): {
  instructions?: {
    global?: WorkspaceContextSnapshots["instructions"]["global"];
    project?: WorkspaceContextSnapshots["instructions"]["project"];
  };
  skills?: {
    global?: WorkspaceContextSnapshots["skills"]["global"];
    project?: WorkspaceContextSnapshots["skills"]["project"];
  };
  agents?: {
    profiles?: {
      global?: WorkspaceContextSnapshots["agents"]["profiles"]["global"];
      project?: WorkspaceContextSnapshots["agents"]["profiles"]["project"];
    };
    providers?: WorkspaceContextSnapshots["agents"]["providers"];
  };
} {
  const projectKey = context.projectKey
    ?? context.workspace.sourceRoot
    ?? context.workspace.root;
  const keys = {
    globalInstructions: JSON.stringify(["global", "instructions"]),
    projectInstructions: JSON.stringify(["project", projectKey, "instructions"]),
    globalSkills: JSON.stringify(["global", "skills"]),
    projectSkills: JSON.stringify(["project", projectKey, "skills"]),
    globalProfiles: JSON.stringify(["global", "agent-profiles"]),
    projectProfiles: JSON.stringify(["project", projectKey, "agent-profiles"]),
    providers: JSON.stringify(["global", "agent-providers"]),
  };
  const values = new Map<string, unknown>([
    [keys.globalInstructions, snapshots.instructions.global],
    [keys.projectInstructions, fingerprintInputs.projectInstructions],
    [keys.globalSkills, fingerprintInputs.globalSkills],
    [keys.projectSkills, fingerprintInputs.projectSkills],
    [keys.globalProfiles, snapshots.agents.profiles.global],
    [keys.projectProfiles, snapshots.agents.profiles.project],
    [keys.providers, snapshots.agents.providers],
  ]);
  const changed = workspaces.claimConversationContexts(
    context,
    Array.from(values, ([contextKey, value]) => ({
      contextKey,
      fingerprint: contextFingerprint(value),
    })),
  );
  const instructions = {
    ...(changed.has(keys.globalInstructions)
      ? { global: snapshots.instructions.global }
      : {}),
    ...(changed.has(keys.projectInstructions)
      ? { project: snapshots.instructions.project }
      : {}),
  };
  const skills = {
    ...(changed.has(keys.globalSkills) ? { global: snapshots.skills.global } : {}),
    ...(changed.has(keys.projectSkills) ? { project: snapshots.skills.project } : {}),
  };
  const profiles = {
    ...(changed.has(keys.globalProfiles)
      ? { global: snapshots.agents.profiles.global }
      : {}),
    ...(changed.has(keys.projectProfiles)
      ? { project: snapshots.agents.profiles.project }
      : {}),
  };
  const agents = {
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    ...(changed.has(keys.providers) ? { providers: snapshots.agents.providers } : {}),
  };

  return {
    ...(Object.keys(instructions).length > 0 ? { instructions } : {}),
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
  };
}

function contextFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedContextText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

async function fileContentFingerprint(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return contextFingerprint(["readable", normalizedContextText(content)]);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
    return contextFingerprint(["unreadable", code]);
  }
}

async function projectInstructionFingerprintInput(
  instructions: WorkspaceContextSnapshots["instructions"]["project"],
  available: Array<{ path: string }>,
  workspaceRoot: string,
): Promise<unknown> {
  return {
    loaded: instructions.loaded.map((file) => ({
      ...file,
      content: normalizedContextText(file.content),
    })),
    available: await Promise.all(available.map(async (file) => ({
      path: formatWorkspaceResourcePath(file.path, workspaceRoot),
      contentFingerprint: await fileContentFingerprint(file.path),
    }))),
  };
}

async function skillFingerprintInputs(
  skills: Array<{
    name: string;
    description: string;
    path: string;
    filePath: string;
    scope: "global" | "project";
  }>,
): Promise<{ global: unknown; project: unknown }> {
  const summarize = async (scope: "global" | "project") => Promise.all(
    skills
      .filter((skill) => skill.scope === scope)
      .map(async ({ scope: _scope, filePath, ...skill }) => ({
        ...skill,
        contentFingerprint: await fileContentFingerprint(filePath),
      })),
  );

  return {
    global: await summarize("global"),
    project: await summarize("project"),
  };
}

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
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config, toolSurface),
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
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
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
        instructions: workspaceInstructionsOutputSchema.optional(),
        skills: workspaceSkillsOutputSchema.optional(),
        agents: workspaceAgentsOutputSchema.optional(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceContext = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: openAiConversationScopeId(_meta) },
      );
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = workspaceContext;
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const scopedSkillCatalog = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatWorkspaceResourcePath(skill.filePath, workspace.root),
          filePath: skill.filePath,
          scope: isPathInsideRoot(skill.filePath, workspace.root) ? "project" as const : "global" as const,
        }));
      const cardSkills = scopedSkillCatalog.map(({ scope: _scope, filePath: _filePath, ...skill }) => skill);
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
      const profileScopes = new Map(workspace.agentProfiles.map((profile) => [profile.name, profile.scope]));
      const scopedAgents = agentCatalog.profiles.map((profile) => ({
        ...profile,
        scope: profileScopes.get(profile.name) ?? "global" as const,
      }));
      const cardAgents = scopedAgents.map(({ scope: _scope, ...profile }) => profile);
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatWorkspaceResourcePath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatWorkspaceResourcePath(file.path, workspace.root),
      }));
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded project instructions. Before working under a path with an available nested instruction file, read that file. When a task matches an available skill, read its SKILL.md before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded project instructions. Before working under a path with an available nested instruction file, read that file.";
      const instructionSnapshots = scopedInstructions(
        agentsFiles,
        availableAgentsFiles,
        workspace.root,
      );
      const skillSnapshots = scopedSkills(scopedSkillCatalog);
      const [projectInstructionFingerprint, skillFingerprints] = await Promise.all([
        projectInstructionFingerprintInput(
          instructionSnapshots.project,
          availableAgentsFiles,
          workspace.root,
        ),
        skillFingerprintInputs(scopedSkillCatalog),
      ]);
      const modelContext = conversationContextOutput(
        workspaces,
        workspaceContext,
        {
          instructions: instructionSnapshots,
          skills: skillSnapshots,
          agents: scopedAgentCatalog(scopedAgents, cardAgentProviders),
        },
        {
          projectInstructions: projectInstructionFingerprint,
          globalSkills: skillFingerprints.global,
          projectSkills: skillFingerprints.project,
        },
      );
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
            workspaceReused
              ? "Continue using this workspaceId for work in this workspace."
              : "Use this workspaceId for work in this workspace.",
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
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          ...modelContext,
        },
      };
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
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
    server,
    config,
    workspaces,
    processSessions,
  });

  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
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
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
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
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );

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
          resolveLocalAgentProviders,
          incomingArtifactAdapters,
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
