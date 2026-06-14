import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import {
  countDiffStats,
  createResultStore,
  type ToolResultStore,
} from "./result-store.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsNotice, WorkspaceRegistry } from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI = "ui://pi-on-mcp/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
// Workaround: ChatGPT currently prompts repeatedly for destructive/local-exec tools.
// Keep the real server behavior unchanged, but advertise these tools as read-only
// until the host has a less noisy approval flow for trusted local workspaces.
const TRUSTED_WORKSPACE_TOOL_ANNOTATIONS = { readOnlyHint: true };

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
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

const storedToolNameSchema = z.enum([
  "open_workspace",
  "read_file",
  "write_file",
  "edit_file",
  "grep_files",
  "find_files",
  "list_directory",
  "run_shell",
]);
const summarySchema = z.record(z.string(), z.unknown());
const uiCardSchema = z.object({
  card: z.string(),
  expandable: z.boolean(),
});
const toolPayloadSchema = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("image"),
          data: z.string(),
          mimeType: z.string(),
        }),
      ]),
    )
    .optional(),
  diff: z.string().optional(),
  patch: z.string().optional(),
});

function cardOutputSchema<TTool extends string>(
  tool: TTool,
  summary: z.ZodType,
  extra: z.ZodRawShape = {},
): z.ZodRawShape {
  return {
    tool: z.literal(tool),
    resultId: z.string(),
    workspaceId: z.string(),
    path: z.string().optional(),
    label: z.string(),
    summary,
    result: z
      .string()
      .describe(
        "Model-readable result text. Mirrors the important tool output for hosts that prioritize structuredContent over content blocks.",
      ),
    ui: uiCardSchema,
    ...extra,
  };
}

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true;

  const authorization = req.header("authorization");
  return authorization === `Bearer ${config.authToken}`;
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

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
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
    <title>Pi MCP Workspace</title>
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

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  results: ToolResultStore,
): McpServer {
  const server = new McpServer(
    {
      name: "local-coding-workspace",
      title: "Local Coding Workspace",
      version: "0.1.0",
      description:
        "Local development harness that exposes workspace-scoped file, search, edit, and shell tools.",
    },
    {
      instructions: config.minimalTools
        ? "Use this server as a local coding workspace harness. First call open_workspace with a project directory inside an allowed root. Then use the returned workspaceId for all file, edit, write, and shell tools. Follow any AGENTS.md context returned by open_workspace or subsequent tool calls. In minimal tool mode, grep_files, find_files, and list_directory are disabled; use run_shell with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. Prefer read_file for direct file reads, edit_file for targeted modifications, write_file only for new files or complete rewrites, and run_shell for tests/builds/git/search/list commands. Do not create or modify files with run_shell; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files."
        : "Use this server as a local coding workspace harness. First call open_workspace with a project directory inside an allowed root. Then use the returned workspaceId for all file, search, edit, write, and shell tools. Follow any AGENTS.md context returned by open_workspace or subsequent tool calls. Prefer read_file and search tools for inspection, edit_file for targeted modifications, write_file only for new files or complete rewrites, and run_shell for tests/builds/git commands. Do not create or modify files with run_shell; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.",
    },
  );

  registerAppResource(
    server,
    "Pi Edit Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing edit_file diffs.",
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
    "get_tool_result_payload",
    {
      title: "Get tool result payload",
      description:
        "Fetch the full payload for a tool result. This is app-only and hidden from the model.",
      inputSchema: {
        workspaceId: z
          .string()
          .optional()
          .describe("Workspace identifier returned by open_workspace."),
        resultId: z.string().describe("Result identifier returned by a tool."),
      },
      outputSchema: {
        tool: z.literal("get_tool_result_payload"),
        resultId: z.string(),
        workspaceId: z.string().optional(),
        sourceTool: storedToolNameSchema,
        label: z.string().optional(),
        path: z.string().optional(),
        summary: summarySchema,
        payload: toolPayloadSchema,
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["app"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, resultId }) => {
      const result = results.get(resultId, workspaceId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded payload for ${result.label ?? result.path ?? result.tool}.`,
          },
        ],
        structuredContent: {
          tool: "get_tool_result_payload",
          resultId,
          workspaceId,
          sourceTool: result.tool,
          label: result.label,
          path: result.path,
          summary: result.summary,
          payload: result.payload,
        },
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. This must be the first tool call before reading, editing, searching, writing, or running commands in a project. Returns a workspaceId and any AGENTS.md instructions discovered at the workspace root.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
      },
      outputSchema: {
        tool: z.literal("open_workspace"),
        resultId: z.string(),
        workspaceId: z.string(),
        root: z.string(),
        label: z.string(),
        summary: z.object({
          agentsFiles: z.number().int().nonnegative(),
        }),
        result: z.string(),
        ui: uiCardSchema,
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const { workspace, agentsFiles } = await workspaces.openWorkspace(path);
      const summary = {
        agentsFiles: agentsFiles.length,
      };
      const storedResult = results.put({
        tool: "open_workspace",
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        label: workspace.root,
        path: workspace.root,
        summary,
        payload: {
          content: [
            {
              type: "text",
              text: formatAgentsNotice(agentsFiles) ?? "",
            },
          ],
        },
      });
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              workspaceId: workspace.id,
              root: workspace.root,
              loadedAgentsFiles: agentsFiles.map((file) => ({
                path: file.path,
                alreadyLoaded: file.alreadyLoaded,
              })),
              instruction:
                "Use this workspaceId in all subsequent tool calls for this project. Follow the AGENTS.md context returned below.",
            },
            null,
            2,
          ),
        },
        ...(formatAgentsNotice(agentsFiles)
          ? [
              {
                type: "text" as const,
                text: formatAgentsNotice(agentsFiles)!,
              },
            ]
          : []),
      ];

      return {
        content: resultContent,
        structuredContent: {
          tool: "open_workspace",
          resultId: storedResult.id,
          workspaceId: workspace.id,
          root: workspace.root,
          label: workspace.root,
          summary,
          result: contentText(resultContent),
          ui: {
            card: "workspace",
            expandable: agentsFiles.length > 0,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId. If the file path enters a directory with an AGENTS.md, that AGENTS.md context is returned as newly loaded or already loaded.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to read, relative to the workspace root."),
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
      outputSchema: cardOutputSchema(
        "read_file",
        z.object({
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
          offset: z.number().int().positive(),
          limited: z.boolean(),
        }),
      ),
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await readFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      const storedResult = results.put({
        workspaceId,
        workspaceRoot: workspace.root,
        tool: "read_file",
        path: input.path,
        label: input.path,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "read_file",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.path,
          summary,
          result: contentText(response.content),
          ui: {
            card: "text",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "write_file",
    {
      title: "Write file",
      description:
        "Create or completely overwrite a file inside an open workspace. Prefer edit_file for targeted changes to existing files. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: cardOutputSchema(
        "write_file",
        z.object({
          additions: z.number().int().nonnegative(),
          removals: z.number().int().nonnegative(),
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
        }),
      ),
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: TRUSTED_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      const storedResult = results.put({
        workspaceId,
        workspaceRoot: workspace.root,
        tool: "write_file",
        path: input.path,
        label: input.path,
        summary,
        payload: {
          content: response.content,
          patch,
        },
      });

      return {
        ...response,
        structuredContent: {
          tool: "write_file",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.path,
          summary,
          result: contentText(response.content),
          ui: {
            card: "write",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "edit_file",
    {
      title: "Edit file",
      description:
        "Edit one file inside an open workspace by replacing exact text blocks. Prefer this over write_file for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.",
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
      outputSchema: cardOutputSchema(
        "edit_file",
        z.object({
          additions: z.number().int().nonnegative(),
          removals: z.number().int().nonnegative(),
          editCount: z.number().int().positive(),
        }),
        {
          status: z.literal("applied"),
        },
      ),
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: TRUSTED_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const diffText = response.details?.patch ?? response.details?.diff ?? "";
      const storedResult = results.put({
        workspaceId,
        workspaceRoot: workspace.root,
        tool: "edit_file",
        path: input.path,
        label: input.path,
        summary: {
          ...stats,
          editCount: input.edits.length,
        },
        payload: {
          diff: response.details?.diff,
          patch: response.details?.patch,
        },
      });
      const editResultText = [
        `Edited ${input.path} (+${stats.additions} -${stats.removals}). Diff available in the UI as ${storedResult.id}.`,
        diffText ? `\nUnified diff:\n${diffText}` : "",
      ].join("");
      const editContent = [
        textBlock(editResultText),
        ...(agentsNotice ? [textBlock(agentsNotice)] : []),
      ];

      return {
        content: editContent,
        structuredContent: {
          tool: "edit_file",
          resultId: storedResult.id,
          workspaceId,
          status: "applied",
          path: input.path,
          label: input.path,
          summary: storedResult.summary,
          result: contentText(editContent),
          ui: {
            card: "file-diff",
            expandable: true,
          },
        },
      };
    },
  );

  if (!config.minimalTools) {
    registerAppTool(
      server,
      "grep_files",
      {
        title: "Grep files",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects the underlying Pi grep behavior, including project ignore rules. Call open_workspace first and pass workspaceId.",
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
        outputSchema: cardOutputSchema(
          "grep_files",
          z.object({
            pattern: z.string(),
            scope: z.string(),
            lines: z.number().int().nonnegative(),
            characters: z.number().int().nonnegative(),
          }),
        ),
        _meta: {
          ui: {
            resourceUri: WORKSPACE_APP_URI,
            visibility: ["model"],
          },
        },
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const targetPath = input.path
          ? workspaces.resolvePath(workspace, input.path)
          : workspace.root;
        const agentsNotice = formatAgentsNotice(
          await workspaces.loadAgentsForPath(workspace, targetPath),
        );
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          agentsNotice,
        });

        if (response.isError) return response;

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const storedResult = results.put({
          workspaceId,
          workspaceRoot: workspace.root,
          tool: "grep_files",
          path: input.path,
          label: input.pattern,
          summary,
          payload: { content: response.content },
        });

        return {
          ...response,
          structuredContent: {
            tool: "grep_files",
            resultId: storedResult.id,
            workspaceId,
            path: input.path,
            label: input.pattern,
            summary,
            result: contentText(response.content),
            ui: {
              card: "search",
              expandable: true,
            },
          },
        };
      },
    );

    registerAppTool(
      server,
      "find_files",
      {
        title: "Find files",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects the underlying Pi find behavior, including project ignore rules. Call open_workspace first and pass workspaceId.",
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
        outputSchema: cardOutputSchema(
          "find_files",
          z.object({
            pattern: z.string(),
            scope: z.string(),
            lines: z.number().int().nonnegative(),
            characters: z.number().int().nonnegative(),
          }),
        ),
        _meta: {
          ui: {
            resourceUri: WORKSPACE_APP_URI,
            visibility: ["model"],
          },
        },
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const targetPath = input.path
          ? workspaces.resolvePath(workspace, input.path)
          : workspace.root;
        const agentsNotice = formatAgentsNotice(
          await workspaces.loadAgentsForPath(workspace, targetPath),
        );
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          agentsNotice,
        });

        if (response.isError) return response;

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const storedResult = results.put({
          workspaceId,
          workspaceRoot: workspace.root,
          tool: "find_files",
          path: input.path,
          label: input.pattern,
          summary,
          payload: { content: response.content },
        });

        return {
          ...response,
          structuredContent: {
            tool: "find_files",
            resultId: storedResult.id,
            workspaceId,
            path: input.path,
            label: input.pattern,
            summary,
            result: contentText(response.content),
            ui: {
              card: "search",
              expandable: true,
            },
          },
        };
      },
    );

    registerAppTool(
      server,
      "list_directory",
      {
        title: "List directory",
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
        outputSchema: cardOutputSchema(
          "list_directory",
          z.object({
            lines: z.number().int().nonnegative(),
            characters: z.number().int().nonnegative(),
          }),
        ),
        _meta: {
          ui: {
            resourceUri: WORKSPACE_APP_URI,
            visibility: ["model"],
          },
        },
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const targetPath = workspaces.resolvePath(workspace, input.path);
        const agentsNotice = formatAgentsNotice(
          await workspaces.loadAgentsForPath(workspace, targetPath),
        );
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
          agentsNotice,
        });

        if (response.isError) return response;

        const summary = textSummary(response.content);
        const storedResult = results.put({
          workspaceId,
          workspaceRoot: workspace.root,
          tool: "list_directory",
          path: input.path,
          label: input.path,
          summary,
          payload: { content: response.content },
        });

        return {
          ...response,
          structuredContent: {
            tool: "list_directory",
            resultId: storedResult.id,
            workspaceId,
            path: input.path,
            label: input.path,
            summary,
            result: contentText(response.content),
            ui: {
              card: "directory",
              expandable: true,
            },
          },
        };
      },
    );
  }

  registerAppTool(
    server,
    "run_shell",
    {
      title: "Run shell",
      description: config.minimalTools
        ? "Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, grep_files, find_files, and list_directory are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use run_shell to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use edit_file for targeted changes and write_file for new files or full rewrites. Prefer read_file for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication."
        : "Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use run_shell to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use edit_file for targeted changes and write_file for new files or full rewrites. Prefer read_file, grep_files, find_files, and list_directory for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            "Shell command to run. Must not create or modify project files; use edit_file or write_file for file changes.",
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
      outputSchema: cardOutputSchema(
        "run_shell",
        z.object({
          command: z.string(),
          workingDirectory: z.string(),
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
        }),
      ),
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: TRUSTED_WORKSPACE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForDirectory(workspace, cwd),
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      const storedResult = results.put({
        workspaceId,
        workspaceRoot: workspace.root,
        tool: "run_shell",
        path: workingDirectory,
        label: input.command,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "run_shell",
          resultId: storedResult.id,
          workspaceId,
          path: workingDirectory,
          label: input.command,
          summary,
          result: contentText(response.content),
          ui: {
            card: "shell",
            expandable: true,
          },
        },
      };
    },
  );

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: Array.from(new Set([config.host, ...config.allowedHosts])),
  });
  const transports = new Map<string, Transport>();
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const results = createResultStore(config.stateDir);

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
    res.json({ ok: true, name: "pi-on-mcp" });
  });

  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req, config)) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      const sessionId = req.header("mcp-session-id");
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createMcpServer(config, workspaces, results);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  return { app, config };
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
      `pi-on-mcp listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(
      config.authToken ? "auth: bearer token required" : "auth: disabled",
    );
  });
}
