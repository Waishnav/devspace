import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  copyArtifactToWorkspace,
  type ArtifactCopyConflictMode,
} from "./artifact-workspace.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ArtifactError,
  type ArtifactRecord,
  type ArtifactStore,
} from "./artifacts.js";
import {
  describeIncomingArtifactValue,
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const openAIFileReferenceInputSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

const artifactRecordOutputSchema = {
  artifactId: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  hostPath: z.string(),
  source: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  pinned: z.boolean(),
};

type ArtifactToolName =
  | "stage_artifact"
  | "artifact_stat"
  | "artifact_copy_to_workspace"
  | "artifact_delete";

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  store: ArtifactStore;
  workspaces: WorkspaceRegistry;
  clientId: string;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export interface StageArtifactInput {
  file: unknown;
  workspaceId?: string;
  expectedSha256?: string;
  ttlHours?: number;
  pin?: boolean;
}

export interface StageArtifactResult {
  artifactId: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  hostPath: string;
  expiresAt?: string;
  instruction: string;
}

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    store,
    workspaces,
    clientId,
    incomingArtifactAdapters = [],
  }: ArtifactToolRegistrationOptions,
): void {
  const incomingRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);

  registerAppTool(
    server,
    "stage_artifact",
    {
      title: "Stage attached or generated file",
      description:
        "Stage one ChatGPT-provided native file reference into private DevSpace storage. DevSpace downloads only the exact file object authorized by ChatGPT; arbitrary URLs and paths fail closed. A workspace ID is association metadata, not a write destination.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe("Native file value authorized and supplied by ChatGPT."),
        workspaceId: z.string().min(1).optional().describe("Optional workspace association; never a write destination."),
        expectedSha256: z.string().optional().describe("Optional expected SHA-256, with or without a sha256: prefix."),
        ttlHours: z.number().int().min(1).max(24 * 365).optional().describe("Artifact lifetime after staging."),
        pin: z.boolean().optional().describe("Preserve the artifact until explicitly deleted."),
      },
      outputSchema: {
        artifactId: z.string(),
        name: z.string(),
        mimeType: z.string().optional(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        hostPath: z.string(),
        expiresAt: z.string().optional(),
        instruction: z.string(),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, "stage_artifact", input, async () => {
      return stageIncomingArtifact({
        store,
        clientId,
        registry: incomingRegistry,
        input,
      });
    }),
  );

  registerAppTool(
    server,
    "artifact_stat",
    {
      title: "Inspect artifact",
      description: "Return private artifact metadata by ID without returning its content.",
      inputSchema: {
        artifactId: z.string(),
      },
      outputSchema: artifactRecordOutputSchema,
      _meta: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }) => executeArtifactTool(
      config,
      "artifact_stat",
      { artifactId },
      async () => store.statArtifact(clientId, artifactId),
    ),
  );

  registerAppTool(
    server,
    "artifact_copy_to_workspace",
    {
      title: "Copy artifact into workspace",
      description:
        "Copy one owner-scoped private artifact into a path inside an already-open workspace. The destination must stay within that workspace; choose rename or replace explicitly when a file exists.",
      inputSchema: {
        artifactId: z.string(),
        workspaceId: z.string().min(1),
        destination: z.string().min(1).describe("Relative path inside the selected workspace."),
        onConflict: z.enum(["error", "rename", "replace"]).default("error"),
      },
      outputSchema: {
        artifactId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string(),
        onConflict: z.enum(["error", "rename", "replace"]),
        renamed: z.boolean(),
      },
      _meta: {},
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(
      config,
      "artifact_copy_to_workspace",
      input,
      async () => {
        const workspace = workspaces.getWorkspace(input.workspaceId);
        const destination = workspaces.resolvePath(workspace, input.destination);
        return copyArtifactToWorkspace({
          store,
          clientId,
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          artifactId: input.artifactId,
          destination,
          onConflict: input.onConflict as ArtifactCopyConflictMode,
        });
      },
    ),
  );

  registerAppTool(
    server,
    "artifact_delete",
    {
      title: "Delete artifact",
      description:
        "Delete an artifact record. Its immutable object is removed only when no other live record references it.",
      inputSchema: {
        artifactId: z.string(),
      },
      outputSchema: {
        artifactId: z.string(),
        deleted: z.boolean(),
        objectDeleted: z.boolean(),
      },
      _meta: {},
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async ({ artifactId }) => executeArtifactTool(
      config,
      "artifact_delete",
      { artifactId },
      async () => store.deleteArtifact(clientId, artifactId),
    ),
  );
}

export async function stageIncomingArtifact({
  store,
  clientId,
  registry,
  input,
}: {
  store: ArtifactStore;
  clientId: string;
  registry: IncomingArtifactAdapterRegistry;
  input: StageArtifactInput;
}): Promise<StageArtifactResult> {
  const opened = await registry.open(input.file);
  let uploadId: string | undefined;

  try {
    const upload = await store.beginUpload(clientId, {
      filename: opened.name,
      mimeType: opened.mimeType,
      size: opened.size,
      sha256: input.expectedSha256,
      workspaceId: input.workspaceId,
      ttlHours: input.ttlHours,
    });
    uploadId = upload.uploadId;

    let offset = 0;
    for await (const value of opened.stream) {
      const bytes = incomingStreamChunk(value);
      for (let chunkOffset = 0; chunkOffset < bytes.length; chunkOffset += ARTIFACT_CHUNK_BYTES) {
        const chunk = bytes.subarray(chunkOffset, chunkOffset + ARTIFACT_CHUNK_BYTES);
        await store.uploadChunk(clientId, {
          uploadId,
          offset,
          dataBase64: chunk.toString("base64"),
        });
        offset += chunk.length;
      }
    }

    const artifact = await store.commitUpload(clientId, uploadId, {
      source: `incoming:${opened.adapterId}`,
      pinned: input.pin === true,
    });
    uploadId = undefined;
    return {
      artifactId: artifact.artifactId,
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      sha256: artifact.sha256,
      hostPath: artifact.hostPath,
      expiresAt: artifact.expiresAt,
      instruction:
        "Pass hostPath to a local command. stage_artifact never writes into a workspace or repository.",
    };
  } catch (error) {
    opened.stream.destroy();
    if (uploadId) {
      await store.abortUpload(clientId, uploadId).catch(() => undefined);
    }
    throw error;
  }
}

function incomingFileDownloadHostname(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
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

export function artifactToolLogFields(
  tool: ArtifactToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (tool === "stage_artifact") {
    return {
      fileProvided: input.file !== undefined,
      fileReferenceShape: describeIncomingArtifactValue(input.file),
      downloadUrlHostname: incomingFileDownloadHostname(input.file),
      workspaceId: input.workspaceId,
      expectedSha256Present: typeof input.expectedSha256 === "string",
      ttlHours: input.ttlHours,
      pin: input.pin === true,
    };
  }
  return { artifactId: input.artifactId };
}

async function executeArtifactTool<T extends object>(
  config: ServerConfig,
  tool: ArtifactToolName,
  input: Record<string, unknown>,
  operation: () => Promise<T> | T,
) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    if (config.logging.toolCalls) {
      logEvent(config.logging, "info", "artifact_tool_call", {
        tool,
        ...artifactToolLogFields(tool, input),
        ...artifactResultLogFields(result as Record<string, unknown>),
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return artifactToolResponse(result);
  } catch (error) {
    if (config.logging.toolCalls) {
      logEvent(config.logging, "warn", "artifact_tool_call", {
        tool,
        ...artifactToolLogFields(tool, input),
        success: false,
        errorCode: error instanceof ArtifactError ? error.code : "internal_error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    throw error;
  }
}

function artifactToolResponse<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function artifactResultLogFields(result: Record<string, unknown>): Record<string, unknown> {
  const artifact = result as Partial<ArtifactRecord>;
  return {
    artifactId: artifact.artifactId,
    size: artifact.size,
    sha256: artifact.sha256,
    source: artifact.source,
    objectDeleted: result.objectDeleted,
  };
}
