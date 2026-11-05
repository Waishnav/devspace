import { isObjectValue, isJsonString } from "./json-value.js";
import type { WireInput, JsonObject } from "./json-value.js";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  assertSameArtifactEntry,
  createPathArtifactDestinationDirectory,
  type ArtifactDestinationDirectory,
  type ArtifactFile,
} from "./artifact-destination.js";
import { ArtifactError } from "./artifact-error.js";
import { parseSafeWindowsArtifactRelativePath } from "./artifact-path-windows.js";
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

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW;
const PARTIAL_PREFIX = ".devspace-download-";
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_PARTIAL_CLEANUP = 32;
const ARTIFACT_DOWNLOAD_PLATFORMS = new Set<NodeJS.Platform>(["linux", "darwin", "win32"]);

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
  return ARTIFACT_DOWNLOAD_PLATFORMS.has(platform);
}

interface ArtifactDestination {
  path: string;
  parentParts: string[];
  name: string;
}

export function registerArtifactTools(
  server: Pick<McpServer, "registerTool">,
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
        "Save an attached or generated file to a relative path inside a workspace. The destination must not already exist.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe(
          "Attached or generated file to save.",
        ),
        workspace_id: z.string().min(1).describe(
          "Workspace to use. Reuse the current project's workspace_id.",
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
      const workspace = await workspaces.getWorkspace(input.workspace_id);

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
  publishEntry = defaultPublishEntry,
}: {
  registry: IncomingArtifactAdapterRegistry;
  workspaceId: string;
  workspaceRoot: string;
  maxFileBytes: number;
  file: WireInput;
  path: string;
  publishEntry?: typeof defaultPublishEntry;
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
  let destinationDirectory: ArtifactDestinationDirectory | undefined;
  let partialName: string | undefined;
  let artifactFile: ArtifactFile | undefined;

  try {
    if (opened.size !== undefined && opened.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Native file exceeds the configured per-file limit.",
      );
    }

    destinationDirectory = await prepareArtifactDestinationDirectory(
      workspaceRoot,
      destination.parentParts,
    );
    await cleanupStalePartials(destinationDirectory);

    partialName = `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`;
    artifactFile = await destinationDirectory.createExclusiveFile(
      partialName,
      0o600,
    );

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

      await artifactFile.writeAll(chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError(
        "artifact_file_size_mismatch",
        "Native file metadata did not match the downloaded content.",
      );
    }

    await artifactFile.sync();
    const writtenEntry = await artifactFile.stat();

    if (!writtenEntry.isFile() || writtenEntry.size !== size) {
      throw new ArtifactError(
        "artifact_write_integrity_failed",
        "Native file could not be verified before publication.",
      );
    }

    assertSameArtifactEntry(
      await destinationDirectory.statRegularFile(partialName),
      writtenEntry,
      "artifact_partial_unsafe",
    );

    await publishDestination(
      destinationDirectory,
      partialName,
      destination.name,
      writtenEntry,
      publishEntry,
    );
    await destinationDirectory.unlink(partialName).catch(() => undefined);
    partialName = undefined;

    return {
      path: destination.path,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    opened.stream.destroy();
    throw error;
  } finally {
    await artifactFile?.close().catch(() => undefined);

    if (partialName) await destinationDirectory?.unlink(partialName).catch(() => undefined);
    await destinationDirectory?.close().catch(() => undefined);
  }
}

export function artifactToolLogFields(
  input: JsonObject,
): JsonObject {
  return {
    fileProvided: input.file !== undefined,
    "fileReferenceShape": describeIncomingArtifactValue(input.file),
    downloadUrlHostname: incomingFileDownloadHostname(input.file),
    workspaceId: input.workspace_id,
    path: input.path,
  };
}

async function executeArtifactTool(
  config: ServerConfig,
  input: JsonObject,
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

async function openDirectoryNoFollow(
  path: string,
  code: string,
  message: string,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(path, DIRECTORY_FLAGS);
    await assertDirectoryHandle(handle);

    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);

    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(code, message);
  }
}

async function assertDirectoryHandle(handle: FileHandle): Promise<void> {
  const entry = await handle.stat();

  if (!entry.isDirectory()) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination parent is not a directory.",
    );
  }
}

function descriptorDirectoryPath(handle: FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  throw new ArtifactError(
    "artifact_platform_unsupported",
    "Native file download requires descriptor-anchored directory operations on this platform.",
  );
}

async function prepareArtifactDestinationDirectory(
  workspaceRoot: string,
  parentParts: readonly string[],
): Promise<ArtifactDestinationDirectory> {
  if (process.platform === "win32") {
    const { prepareWindowsArtifactDestinationDirectory } = await import(
      "./artifact-destination-windows.js"
    );

    return prepareWindowsArtifactDestinationDirectory(workspaceRoot, parentParts);
  }

  if (process.platform === "darwin") {
    const { prepareDarwinArtifactDestinationDirectory } = await import(
      "./artifact-destination-darwin.js"
    );

    return prepareDarwinArtifactDestinationDirectory(workspaceRoot, parentParts);
  }

  return prepareLinuxArtifactDestinationDirectory(workspaceRoot, parentParts);
}

function normalizeArtifactDestination(value: string): ArtifactDestination {
  if (process.platform === "win32") {
    const parsed = parseSafeWindowsArtifactRelativePath(value);

    if (!parsed) {
      throw new ArtifactError(
        "artifact_destination_invalid",
        "Artifact destination must be a safe relative Windows file path inside the workspace.",
      );
    }

    return {
      path: parsed.path,
      parentParts: parsed.parts.slice(0, -1),
      name: parsed.name,
    };
  }

  const rawParts = value.split(sep);

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

async function prepareLinuxArtifactDestinationDirectory(
  workspaceRoot: string,
  parentParts: readonly string[],
): Promise<ArtifactDestinationDirectory> {
  const rootHandle = await openDirectoryNoFollow(
    workspaceRoot,
    "artifact_workspace_unsafe",
    "Selected workspace root is not a real directory.",
  );

  const openedHandles: FileHandle[] = [];
  let parentHandle = rootHandle;
  let parentAnchor = descriptorDirectoryPath(rootHandle);

  try {
    for (const part of parentParts) {
      const child = await ensureWorkspaceChildDirectory(
        parentHandle,
        parentAnchor,
        part,
      );

      openedHandles.push(child);
      parentHandle = child;
      parentAnchor = descriptorDirectoryPath(child);
    }

    return createPathArtifactDestinationDirectory(
      parentAnchor,
      async () => {
        for (const handle of openedHandles.reverse()) {
          await handle.close().catch(() => undefined);
        }

        await rootHandle.close().catch(() => undefined);
      },
    );
  } catch (error) {
    for (const handle of openedHandles.reverse()) {
      await handle.close().catch(() => undefined);
    }

    await rootHandle.close().catch(() => undefined);
    throw error;
  }
}

async function ensureWorkspaceChildDirectory(
  parentHandle: FileHandle,
  parentAnchor: string,
  name: string,
): Promise<FileHandle> {
  await assertDirectoryHandle(parentHandle);
  const path = join(parentAnchor, name);

  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }

  return openDirectoryNoFollow(
    path,
    "artifact_destination_parent_unsafe",
    "Artifact destination parent must be a real directory inside the workspace.",
  );
}

async function publishDestination(
  directory: ArtifactDestinationDirectory,
  partialName: string,
  filename: string,
  writtenEntry: Awaited<ReturnType<ArtifactFile["stat"]>>,
  publishEntry: typeof defaultPublishEntry,
): Promise<void> {
  try {
    await publishEntry(directory, partialName, filename);
    assertSameArtifactEntry(
      await directory.statRegularFile(filename),
      writtenEntry,
      "artifact_destination_publish_failed",
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ArtifactError(
        "artifact_destination_exists",
        "Artifact destination already exists.",
      );
    }

    // Once the destination path exists, never unlink it during failure cleanup.
    // Another process may have replaced that path after publication, and a
    // path-based verification followed by unlink would introduce another race.
    throw error;
  }
}

function defaultPublishEntry(
  directory: ArtifactDestinationDirectory,
  partialName: string,
  filename: string,
): Promise<void> {
  return directory.link(partialName, filename);
}

async function cleanupStalePartials(
  directory: ArtifactDestinationDirectory,
): Promise<void> {
  const entries = await directory.listEntries();
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;

  for (const name of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;

    if (
      !name.startsWith(PARTIAL_PREFIX)
      || !name.endsWith(PARTIAL_SUFFIX)
    ) continue;
    inspected += 1;

    const metadata = await directory.statRegularFile(name);

    if (
      !metadata
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await directory.unlink(name).catch(() => undefined);
  }
}

function incomingFileDownloadHostname(value: WireInput): string | undefined {
  if (!isObjectValue(value) || value === null || Array.isArray(value)) {
    return undefined;
  }

  // SAFETY: The surrounding checks or construction already match this type.
  const rawUrl = (value as JsonObject).download_url;

  if (!isJsonString(rawUrl)) return undefined;

  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();

    return hostname.length > 0 && hostname.length <= 253 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function incomingStreamChunk(value: WireInput): Buffer {
  if (Buffer.isBuffer(value)) return value;

  if (isJsonString(value)) return Buffer.from(value);

  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new ArtifactError(
    "invalid_incoming_artifact_chunk",
    "Incoming artifact stream yielded a value that is not bytes or text.",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
