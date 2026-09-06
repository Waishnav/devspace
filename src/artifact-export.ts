import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ArtifactError } from "./artifact-error.js";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const ARTIFACT_EXPORT_TTL_MS = 5 * 60 * 1_000;
export const ARTIFACT_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_EXPORTS = 128;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const MIME_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain; charset=utf-8"],
  [".ts", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".zip", "application/zip"],
]);

interface ExportedArtifact {
  token: string;
  handle: FileHandle;
  name: string;
  mimeType: string;
  size: number;
  expiresAtMs: number;
  activeReads: number;
  expired: boolean;
  timer: NodeJS.Timeout | undefined;
}

export interface ExportArtifactResult {
  name: string;
  mimeType: string;
  size: number;
  expiresAt: number;
  uri: string;
}

const exportsByToken = new Map<string, ExportedArtifact>();

function artifactResourceUri(token: string): string {
  return `artifact://devspace/${token}`;
}

function artifactMimeType(name: string): string {
  return MIME_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";
}

function isTextMimeType(value: string): boolean {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType.endsWith("+json")
    || mimeType === "application/xml"
    || mimeType.endsWith("+xml")
    || mimeType === "application/javascript"
    || mimeType === "application/yaml";
}

function isInsideRoot(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === "" || (
    !isAbsolute(relationship)
    && relationship !== ".."
    && !relationship.startsWith(`..${sep}`)
  );
}

function expireArtifact(artifact: ExportedArtifact): void {
  if (artifact.expired) return;
  artifact.expired = true;
  if (artifact.timer) clearTimeout(artifact.timer);
  artifact.timer = undefined;
  exportsByToken.delete(artifact.token);
  if (artifact.activeReads === 0) void artifact.handle.close().catch(() => undefined);
}

function lookupArtifact(token: string): ExportedArtifact | undefined {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const artifact = exportsByToken.get(token);
  if (!artifact) return undefined;
  if (Date.now() >= artifact.expiresAtMs) {
    expireArtifact(artifact);
    return undefined;
  }
  return artifact;
}

function retainArtifact(artifact: ExportedArtifact): () => void {
  artifact.activeReads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    artifact.activeReads -= 1;
    if (artifact.expired && artifact.activeReads === 0) {
      void artifact.handle.close().catch(() => undefined);
    }
  };
}

export async function exportWorkspaceArtifact({
  workspaceRoot,
  filePath,
  maxFileBytes = ARTIFACT_RESOURCE_MAX_BYTES,
  ttlMs = ARTIFACT_EXPORT_TTL_MS,
}: {
  workspaceRoot: string;
  filePath: string;
  maxFileBytes?: number;
  ttlMs?: number;
}): Promise<ExportArtifactResult> {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactError(
      "artifact_limit_invalid",
      "Artifact file-size limit must be a positive integer.",
    );
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new ArtifactError(
      "artifact_export_ttl_invalid",
      "Artifact export TTL must be a positive integer.",
    );
  }

  for (const artifact of exportsByToken.values()) {
    if (Date.now() >= artifact.expiresAtMs) expireArtifact(artifact);
  }
  if (exportsByToken.size >= MAX_ACTIVE_EXPORTS) {
    throw new ArtifactError(
      "artifact_export_capacity",
      "Too many artifact exports are active. Try again after an existing export expires.",
    );
  }

  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
    canonicalFile = await realpath(filePath);
  } catch {
    throw new ArtifactError(
      "artifact_export_source_invalid",
      "Artifact export source must be an existing regular file inside the selected workspace.",
    );
  }
  if (!isInsideRoot(canonicalFile, canonicalRoot) || canonicalFile === canonicalRoot) {
    throw new ArtifactError(
      "artifact_export_path_escape",
      "Artifact export source must resolve to a file inside the selected workspace.",
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalFile, fsConstants.O_RDONLY | NO_FOLLOW).catch(() => {
      throw new ArtifactError(
        "artifact_export_source_invalid",
        "Artifact export source must be an existing regular file inside the selected workspace.",
      );
    });
    const metadata = await handle.stat();
    const [verifiedPath, pathMetadata] = await Promise.all([
      realpath(canonicalFile),
      lstat(canonicalFile),
    ]).catch(() => {
      throw new ArtifactError(
        "artifact_export_source_changed",
        "Artifact export source changed while it was being opened.",
      );
    });
    if (
      verifiedPath !== canonicalFile
      || !isInsideRoot(verifiedPath, canonicalRoot)
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.dev !== metadata.dev
      || pathMetadata.ino !== metadata.ino
    ) {
      throw new ArtifactError(
        "artifact_export_source_changed",
        "Artifact export source changed while it was being opened.",
      );
    }
    if (!metadata.isFile()) {
      throw new ArtifactError(
        "artifact_export_source_invalid",
        "Artifact export source must be a regular file.",
      );
    }
    const effectiveMaxFileBytes = Math.min(maxFileBytes, ARTIFACT_RESOURCE_MAX_BYTES);
    if (metadata.size > effectiveMaxFileBytes) {
      throw new ArtifactError(
        "artifact_export_too_large",
        "Artifact export exceeds the configured MCP resource materialization limit.",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + ttlMs;
    const name = basename(canonicalFile);
    const artifact: ExportedArtifact = {
      token,
      handle,
      name,
      mimeType: artifactMimeType(name),
      size: metadata.size,
      expiresAtMs,
      activeReads: 0,
      expired: false,
      timer: undefined,
    };
    artifact.timer = setTimeout(() => expireArtifact(artifact), ttlMs);
    artifact.timer.unref?.();
    exportsByToken.set(token, artifact);
    handle = undefined;

    return {
      name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      expiresAt: Math.floor(expiresAtMs / 1_000),
      uri: artifactResourceUri(token),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readExportedArtifactResource(token: string, uri: string) {
  const artifact = lookupArtifact(token);
  if (!artifact) {
    throw new ArtifactError(
      "artifact_export_missing",
      "Exported artifact is no longer available.",
    );
  }

  const release = retainArtifact(artifact);
  try {
    const chunks: Buffer[] = [];
    const stream = artifact.handle.createReadStream({ start: 0, autoClose: false });
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (isTextMimeType(artifact.mimeType)) {
      return {
        contents: [{
          uri,
          mimeType: artifact.mimeType,
          text: bytes.toString("utf8"),
        }],
      };
    }
    return {
      contents: [{
        uri,
        mimeType: artifact.mimeType,
        blob: bytes.toString("base64"),
      }],
    };
  } finally {
    release();
  }
}

export function registerArtifactExportTool(
  server: McpServer,
  {
    config,
    workspaces,
  }: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
  },
): void {
  server.registerResource(
    "Exported workspace artifact",
    new ResourceTemplate("artifact://devspace/{token}", { list: undefined }),
    {
      description: "Short-lived workspace file exported for MCP host attachment materialization.",
    },
    async (uri, variables) => {
      const token = typeof variables.token === "string" ? variables.token : "";
      return readExportedArtifactResource(token, uri.toString());
    },
  );

  server.registerTool(
    "export_artifact",
    {
      title: "Attach workspace file",
      description:
        "Send one existing workspace file to the MCP host as a native attachment. Use read instead when the goal is only to inspect file contents. The source must resolve inside the selected workspace and is bounded by artifacts.maxFileBytes plus an 8 MiB MCP materialization ceiling.",
      inputSchema: {
        workspaceId: z.string().min(1).describe(
          "Workspace to use. Reuse the current project's workspaceId.",
        ),
        path: z.string().min(1).describe(
          "Path to an existing file inside the selected workspace.",
        ),
      },
      outputSchema: {
        name: z.string(),
        mimeType: z.string(),
        size: z.number().int().nonnegative(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(input.workspaceId);
        const filePath = workspaces.resolvePath(workspace, input.path);
        const exported = await exportWorkspaceArtifact({
          workspaceRoot: workspace.root,
          filePath,
          maxFileBytes: config.artifactMaxFileBytes,
        });
        if (config.logging.toolCalls) {
          logEvent(config.logging, "info", "artifact_tool_call", {
            tool: "export_artifact",
            workspaceId: workspace.id,
            size: exported.size,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
        }
        const publicResult = {
          name: exported.name,
          mimeType: exported.mimeType,
          size: exported.size,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(publicResult) },
            {
              type: "resource_link" as const,
              uri: exported.uri,
              name: exported.name,
              mimeType: exported.mimeType,
              size: exported.size,
            },
          ],
          structuredContent: publicResult,
        };
      } catch (error) {
        if (config.logging.toolCalls) {
          logEvent(config.logging, "warn", "artifact_tool_call", {
            tool: "export_artifact",
            workspaceId: input.workspaceId,
            success: false,
            errorCode: error instanceof ArtifactError ? error.code : "internal_error",
            durationMs: Math.round(performance.now() - startedAt),
          });
        }
        throw error;
      }
    },
  );
}

export async function shutdownArtifactExports(): Promise<void> {
  const artifacts = [...exportsByToken.values()];
  for (const artifact of artifacts) expireArtifact(artifact);
  await Promise.all(
    artifacts.map(async (artifact) => {
      if (artifact.activeReads === 0) await artifact.handle.close().catch(() => undefined);
    }),
  );
}

export const clearExportedArtifactsForTests = shutdownArtifactExports;
