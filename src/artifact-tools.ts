import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ArtifactError } from "./artifact-error.js";
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
const ARTIFACT_DOWNLOAD_PLATFORMS = new Set<NodeJS.Platform>([
  "linux",
  "darwin",
  "freebsd",
  "openbsd",
  "netbsd",
]);

const openAIFileReferenceInputSchema = z.object({
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

interface SecureDestinationDirectory {
  handle: FileHandle;
  anchorPath: string;
  close(): Promise<void>;
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
      "Native file download requires descriptor-anchored directory operations on this platform.",
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
  let workspaceHandle: FileHandle | undefined;
  let destinationDirectory: SecureDestinationDirectory | undefined;
  let partialPath: string | undefined;
  let handle: FileHandle | undefined;

  try {
    if (opened.size !== undefined && opened.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Native file exceeds the configured per-file limit.",
      );
    }

    workspaceHandle = await openDirectoryNoFollow(
      workspaceRoot,
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
    );
    destinationDirectory = await prepareDestinationDirectory(
      workspaceHandle,
      destination.parentParts,
    );
    await cleanupStalePartials(destinationDirectory);

    partialPath = join(
      destinationDirectory.anchorPath,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    handle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
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
      await writeAll(handle, chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError(
        "artifact_file_size_mismatch",
        "Native file metadata did not match the downloaded content.",
      );
    }

    await handle.sync();
    const writtenEntry = await handle.stat();
    if (!writtenEntry.isFile() || writtenEntry.size !== size) {
      throw new ArtifactError(
        "artifact_write_integrity_failed",
        "Native file could not be verified before publication.",
      );
    }

    const partialEntry = await lstat(partialPath);
    if (
      partialEntry.isSymbolicLink()
      || !partialEntry.isFile()
      || partialEntry.dev !== writtenEntry.dev
      || partialEntry.ino !== writtenEntry.ino
      || partialEntry.size !== writtenEntry.size
    ) {
      throw new ArtifactError(
        "artifact_partial_unsafe",
        "Native file partial changed before publication.",
      );
    }

    await publishDestination(
      destinationDirectory,
      partialPath,
      destination.name,
      writtenEntry,
      handle,
      publishLink,
    );
    await unlink(partialPath).catch(() => undefined);
    partialPath = undefined;

    return {
      path: destination.path,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    opened.stream.destroy();
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    await destinationDirectory?.close().catch(() => undefined);
    await workspaceHandle?.close().catch(() => undefined);
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
  if (isArtifactDownloadSupportedPlatform()) {
    return `/dev/fd/${handle.fd}`;
  }
  throw new ArtifactError(
    "artifact_platform_unsupported",
    "Native file download requires descriptor-anchored directory operations on this platform.",
  );
}

function normalizeArtifactDestination(value: string): ArtifactDestination {
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

async function prepareDestinationDirectory(
  rootHandle: FileHandle,
  parentParts: readonly string[],
): Promise<SecureDestinationDirectory> {
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

    return {
      handle: parentHandle,
      anchorPath: parentAnchor,
      async close() {
        for (const handle of openedHandles.reverse()) {
          await handle.close().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    for (const handle of openedHandles.reverse()) {
      await handle.close().catch(() => undefined);
    }
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
  directory: SecureDestinationDirectory,
  partialPath: string,
  filename: string,
  writtenEntry: Awaited<ReturnType<FileHandle["stat"]>>,
  handle: FileHandle,
  publishLink: typeof link,
): Promise<void> {
  await assertDirectoryHandle(directory.handle);
  const candidate = join(directory.anchorPath, filename);
  try {
    await handle.chmod(0o644);
    await handle.sync();
    await publishLink(partialPath, candidate);
    assertPublishedArtifactEntry(await lstat(candidate), writtenEntry);
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

function assertPublishedArtifactEntry(
  entry: Awaited<ReturnType<typeof lstat>>,
  writtenEntry: Awaited<ReturnType<FileHandle["stat"]>>,
): void {
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || entry.dev !== writtenEntry.dev
    || entry.ino !== writtenEntry.ino
    || entry.size !== writtenEntry.size
  ) {
    throw new ArtifactError(
      "artifact_destination_publish_failed",
      "Published artifact did not match the verified download.",
    );
  }
}

async function cleanupStalePartials(
  directory: SecureDestinationDirectory,
): Promise<void> {
  await assertDirectoryHandle(directory.handle);
  const entries = await readdir(directory.anchorPath, { withFileTypes: true });
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
  for (const entry of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;
    if (
      !entry.name.startsWith(PARTIAL_PREFIX)
      || !entry.name.endsWith(PARTIAL_SUFFIX)
    ) continue;
    inspected += 1;

    const path = join(directory.anchorPath, entry.name);
    const metadata = await lstatOrUndefined(path);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await unlink(path).catch(() => undefined);
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ArtifactError(
        "artifact_short_write",
        "Native file was not fully written.",
      );
    }
    offset += bytesWritten;
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

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
