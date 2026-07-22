import { createHash } from "node:crypto";
import { link } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ArtifactError } from "./artifact-error.js";
import {
  isSecureArtifactPlatformSupported,
  openSecureArtifactTarget,
  type SecureArtifactTarget,
} from "./artifact-secure-filesystem.js";
import type { ServerConfig } from "./config.js";
import {
  describeIncomingArtifactValue,
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const openAIFileReferenceInputSchema = z.strictObject({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export interface DownloadIncomingArtifactInput {
  file: unknown;
  workspaceId: string;
  path: string;
}

export interface DownloadIncomingArtifactResult {
  path: string;
  size: number;
  sha256: string;
}

export function isArtifactDownloadSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isSecureArtifactPlatformSupported(platform);
}

interface ArtifactDestination {
  path: string;
  parentParts: string[];
  name: string;
}

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    workspaces,
    incomingArtifactAdapters = [],
  }: ArtifactToolRegistrationOptions,
): void {
  const incomingRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);

  registerAppTool(
    server,
    "download_artifact",
    {
      title: "Download attached or generated file",
      description:
        "Stream one MCP-host-provided native file to a requested relative path inside an already-open workspace. Existing destinations, arbitrary URLs, absolute paths, traversal, symlinked parents, local source paths, and malformed file objects are rejected.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe(
          "Native file value authorized and supplied by the MCP host.",
        ),
        workspaceId: z.string().min(1).describe(
          "Workspace identifier returned by open_workspace.",
        ),
        path: z.string().min(1).describe(
          "Relative destination path inside the selected workspace. The destination must not already exist.",
        ),
      },
      outputSchema: {
        path: z.string(),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, input, async () => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const downloaded = await downloadIncomingArtifact({
        registry: incomingRegistry,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        maxFileBytes: config.artifactMaxFileBytes,
        file: input.file,
        path: input.path,
      });
      return {
        publicResult: { path: downloaded.path },
        logResult: downloaded,
      };
    }),
  );
}

/**
 * Stream a trusted native file directly into one already-open workspace.
 *
 * Bytes are written to an exclusive partial beside the requested destination,
 * hashed and size-checked, fsynced, and only then published without overwriting
 * the requested workspace path. No project-level staging directory is created.
 */
export async function downloadIncomingArtifact({
  registry,
  workspaceId,
  workspaceRoot,
  maxFileBytes,
  file,
  path,
  publishLink = link,
}: {
  registry: IncomingArtifactAdapterRegistry;
  workspaceId: string;
  workspaceRoot: string;
  maxFileBytes: number;
  file: unknown;
  path: string;
  publishLink?: typeof link;
}): Promise<DownloadIncomingArtifactResult> {
  if (!isArtifactDownloadSupportedPlatform()) {
    throw new ArtifactError(
      "artifact_platform_unsupported",
      "Native file download requires secure platform filesystem primitives.",
    );
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactError(
      "artifact_limit_invalid",
      "Artifact file-size limit must be a positive integer.",
    );
  }
  if (!workspaceId) {
    throw new ArtifactError(
      "artifact_workspace_invalid",
      "A selected workspace is required for native file download.",
    );
  }

  const destination = normalizeArtifactDestination(path);
  const opened = await registry.open(file);
  let target: SecureArtifactTarget | undefined;

  try {
    if (opened.size !== undefined && opened.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Native file exceeds the configured per-file limit.",
      );
    }

    target = await openSecureArtifactTarget({
      workspaceRoot,
      parentParts: destination.parentParts,
      name: destination.name,
      publishLink,
    });

    const hash = createHash("sha256");
    let size = 0;
    for await (const value of opened.stream) {
      const chunk = incomingStreamChunk(value);
      if (size + chunk.length > maxFileBytes) {
        throw new ArtifactError(
          "artifact_file_too_large",
          "Native file exceeds the configured per-file limit.",
        );
      }
      await target.writeAll(chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError(
        "artifact_file_size_mismatch",
        "Native file metadata did not match the downloaded content.",
      );
    }

    await target.syncAndVerify(size);
    await target.publish();

    return {
      path: destination.path,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    opened.stream.destroy();
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
  }
}

export function artifactToolLogFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    fileProvided: input.file !== undefined,
    fileReferenceShape: describeIncomingArtifactValue(input.file),
    downloadUrlHostname: incomingFileDownloadHostname(input.file),
    workspaceId: input.workspaceId,
    path: input.path,
  };
}

async function executeArtifactTool(
  config: ServerConfig,
  input: Record<string, unknown>,
  operation: () => Promise<{
    publicResult: { path: string };
    logResult: DownloadIncomingArtifactResult;
  }>,
) {
  const startedAt = performance.now();
  try {
    const { publicResult, logResult } = await operation();
    if (config.logging.toolCalls) {
      logEvent(config.logging, "info", "artifact_tool_call", {
        tool: "download_artifact",
        ...artifactToolLogFields(input),
        path: logResult.path,
        size: logResult.size,
        sha256: logResult.sha256,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return artifactToolResponse(publicResult);
  } catch (error) {
    if (config.logging.toolCalls) {
      logEvent(config.logging, "warn", "artifact_tool_call", {
        tool: "download_artifact",
        ...artifactToolLogFields(input),
        success: false,
        errorCode: error instanceof ArtifactError ? error.code : "internal_error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    throw error;
  }
}

function artifactToolResponse(result: { path: string }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function normalizeArtifactDestination(value: string): ArtifactDestination {
  const rawParts = process.platform === "win32" ? value.split(/[\\/]/) : value.split(sep);
  if (
    !value
    || value.includes("\u0000")
    || isAbsolute(value)
    || value.endsWith(sep)
    || rawParts.includes("..")
  ) {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must be a non-empty relative file path inside the workspace.",
    );
  }

  const normalized = normalize(value);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must stay inside the selected workspace.",
    );
  }

  const parts = normalized.split(sep);
  if (process.platform === "win32") validateWindowsDestinationParts(parts);
  const name = parts.at(-1);
  if (!name || name === "." || name === "..") {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must name a file inside the selected workspace.",
    );
  }

  return {
    path: normalized,
    parentParts: parts.slice(0, -1),
    name,
  };
}

function validateWindowsDestinationParts(parts: readonly string[]): void {
  const reservedDevice = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;
  const forbiddenCharacter = /[<>:"|?*\u0000-\u001f]/;
  for (const part of parts) {
    if (
      !part
      || part.endsWith(".")
      || part.endsWith(" ")
      || forbiddenCharacter.test(part)
      || reservedDevice.test(part)
    ) {
      throw new ArtifactError(
        "artifact_destination_invalid",
        "Artifact destination contains a Windows-reserved path segment.",
      );
    }
  }
}

function incomingFileDownloadHostname(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const rawUrl = (value as Record<string, unknown>).download_url;
  if (typeof rawUrl !== "string") return undefined;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.length > 0 && hostname.length <= 253 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function incomingStreamChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ArtifactError(
    "invalid_incoming_artifact_chunk",
    "Incoming artifact stream yielded a value that is not bytes or text.",
  );
}
