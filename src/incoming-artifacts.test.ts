import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  registerArtifactTools,
  stageIncomingArtifact,
} from "./artifact-tools.js";
import { ArtifactError, ArtifactStore } from "./artifacts.js";
import {
  IncomingArtifactAdapterRegistry,
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-incoming-artifacts-test-"));

try {
  await testRegistryFailsClosed();
  testChatGPTFileDescriptor();
  await testOpenAIFileAdapter(join(root, "openai"));
  await testStageArtifact(join(root, "stage"));
  await testFailedStageCleanup(join(root, "failed-stage"));
  testStageLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

function testChatGPTFileDescriptor(): void {
  const registered = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool(
      name: string,
      descriptor: Record<string, unknown>,
      _callback: unknown,
    ) {
      registered.set(name, descriptor);
      return {};
    },
  };

  registerArtifactTools(server as never, {
    config: {} as never,
    store: {} as never,
    workspaces: {} as never,
    clientId: "client-a",
  });

  assert.deepEqual([...registered.keys()], [
    "stage_artifact",
    "artifact_stat",
    "artifact_copy_to_workspace",
    "artifact_delete",
  ]);
  const descriptor = registered.get("stage_artifact");
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });

  const inputSchema = descriptor.inputSchema as z.ZodRawShape;
  const fileSchema = inputSchema.file as z.ZodType;
  const valid = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  assert.deepEqual(fileSchema.parse(valid), valid);
  const generated = {
    ...valid,
    mime_type: null,
    file_name: null,
    name: "/mnt/data/generated.png",
    size: 123,
  };
  assert.deepEqual(fileSchema.parse(generated), generated);
  assert.throws(() => fileSchema.parse({ file_id: "file_123" }));
  assert.throws(() => fileSchema.parse({ ...valid, mime_type: 123 }));

  const jsonSchema = z.toJSONSchema(fileSchema) as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(jsonSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(jsonSchema.properties ?? {}).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
    "name",
    "size",
  ]);
  assert.deepEqual([...(jsonSchema.required ?? [])].sort(), ["download_url", "file_id"]);
}

async function testOpenAIFileAdapter(testRoot: string): Promise<void> {
  const bytes = Buffer.from("chatgpt generated image bytes");
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-type": "image/png",
      },
    });
  };
  const registry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({ fetch: fetchImpl }),
  ]);
  const reference = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  const generatedReference = {
    download_url: "https://oaisdmntprcentralindia.blob.core.windows.net/chatgpt-file/generated-image.png?sig=secret",
    file_id: "file-service://generated+opaque/abc123",
    mime_type: null,
    file_name: null,
    name: "/mnt/data/generated-image.png",
    size: bytes.length,
  };

  const opened = await registry.open(reference);
  assert.equal(opened.adapterId, "openai-file");
  assert.equal(opened.name, "generated.png");
  assert.equal(opened.mimeType, "image/png");
  assert.equal(opened.size, bytes.length);
  assert.deepEqual(await collect(opened.stream), bytes);

  const generatedOpened = await registry.open(generatedReference);
  assert.equal(generatedOpened.name, "generated-image.png");
  assert.equal(generatedOpened.mimeType, "image/png");
  assert.deepEqual(await collect(generatedOpened.stream), bytes);

  const store = createStore(testRoot);
  try {
    const staged = await stageIncomingArtifact({
      store,
      clientId: "client-a",
      registry,
      input: { file: generatedReference },
    });
    assert.equal(staged.name, "generated-image.png");
    assert.equal(staged.mimeType, "image/png");
    assert.deepEqual(await readFile(staged.hostPath), bytes);
    assert.equal(
      store.statArtifact("client-a", staged.artifactId).source,
      "incoming:openai-file",
    );
  } finally {
    store.close();
  }

  const fallbackOpened = await registry.open({
    ...generatedReference,
    file_name: null,
    name: null,
  });
  assert.equal(fallbackOpened.name, "chatgpt-file.png");
  fallbackOpened.stream.destroy();

  await expectArtifactError(
    registry.open({
      ...generatedReference,
      file_name: "first.png",
      name: "second.png",
    }),
    "ambiguous_openai_file_name",
  );
  await expectArtifactError(
    registry.open({ ...generatedReference, size: bytes.length + 1 }),
    "openai_file_size_mismatch",
  );
  await expectArtifactError(
    registry.open({ ...reference, download_url: "https://example.test/private.png" }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "https://attacker.blob.core.windows.net/private.png",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({ ...reference, download_url: "http://files.oaiusercontent.com/file_123" }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({ ...reference, file_id: "file_\u0000secret" }),
    "invalid_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({ ...reference, file_id: "x".repeat(513) }),
    "invalid_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({ ...reference, bearer: "secret" }),
    "unsupported_incoming_artifact",
  );

  let redirectRequests = 0;
  const redirectingRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async () => {
        redirectRequests += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    }),
  ]);
  await expectArtifactError(
    redirectingRegistry.open(reference),
    "unsafe_openai_file_reference",
  );
  assert.equal(redirectRequests, 1);
  assert.deepEqual(requested, [
    reference.download_url,
    generatedReference.download_url,
    generatedReference.download_url,
    generatedReference.download_url,
    generatedReference.download_url,
  ]);
}

async function testRegistryFailsClosed(): Promise<void> {
  const empty = new IncomingArtifactAdapterRegistry();
  await expectArtifactError(
    empty.open("https://example.test/file.txt?token=secret"),
    "unsupported_incoming_artifact",
  );
  await expectArtifactError(empty.open("/tmp/arbitrary.txt"), "unsupported_incoming_artifact");
  await expectArtifactError(
    empty.open({ url: "https://example.test/file.txt" }),
    "unsupported_incoming_artifact",
  );

  const first = memoryAdapter("first", Buffer.from("first"));
  const second = memoryAdapter("second", Buffer.from("second"));
  await expectArtifactError(
    new IncomingArtifactAdapterRegistry([first, second]).open({ kind: "memory" }),
    "ambiguous_incoming_artifact",
  );
  assert.throws(
    () => new IncomingArtifactAdapterRegistry([{ ...first, id: "Bad Adapter" }]),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_incoming_adapter",
  );
}

async function testStageArtifact(testRoot: string): Promise<void> {
  const bytes = Buffer.alloc(80 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 17) % 256;
  const store = createStore(testRoot);
  try {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const registry = new IncomingArtifactAdapterRegistry([
      memoryAdapter("memory-test", bytes),
    ]);
    const result = await stageIncomingArtifact({
      store,
      clientId: "client-a",
      registry,
      input: {
        file: { kind: "memory" },
        workspaceId: "ws_association_only",
        expectedSha256: `sha256:${digest}`,
        ttlHours: 12,
        pin: true,
      },
    });

    assert.equal(result.name, "payload.bin");
    assert.equal(result.mimeType, "application/octet-stream");
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, `sha256:${digest}`);
    assert.match(result.instruction, /never writes into a workspace or repository/);
    assert.deepEqual(await readFile(result.hostPath), bytes);

    const record = store.statArtifact("client-a", result.artifactId);
    assert.equal(record.source, "incoming:memory-test");
    assert.equal(record.workspaceId, "ws_association_only");
    assert.equal(record.pinned, true);
    assert.equal(store.health().pendingUploads, 0);
  } finally {
    store.close();
  }
}

async function testFailedStageCleanup(testRoot: string): Promise<void> {
  const store = createStore(testRoot);
  try {
    const registry = new IncomingArtifactAdapterRegistry([
      memoryAdapter("memory-test", Buffer.from("digest mismatch")),
    ]);
    await expectArtifactError(
      stageIncomingArtifact({
        store,
        clientId: "client-a",
        registry,
        input: {
          file: { kind: "memory" },
          expectedSha256: "0".repeat(64),
        },
      }),
      "sha256_mismatch",
    );
    assert.equal(store.health().pendingUploads, 0);
    assert.equal(store.health().storedBytes, 0);
  } finally {
    store.close();
  }
}

function testStageLogRedaction(): void {
  const secret = "https://files.example.test/download?token=super-secret";
  const fields = artifactToolLogFields("stage_artifact", {
    file: { download_url: secret, href: secret, bearer: "Bearer secret" },
    workspaceId: "ws_123",
    expectedSha256: "f".repeat(64),
    ttlHours: 24,
    pin: true,
  });
  const serialized = JSON.stringify(fields);
  assert.equal("file" in fields, false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(fields.fileProvided, true);
  assert.equal(fields.downloadUrlHostname, "files.example.test");
  assert.equal(fields.expectedSha256Present, true);
}

function memoryAdapter(id: string, bytes: Buffer): IncomingArtifactAdapter {
  return {
    id,
    canHandle: (value) => (
      typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && (value as { kind?: unknown }).kind === "memory"
    ),
    async open() {
      return {
        name: "payload.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        stream: Readable.from(bytes),
      };
    },
  };
}

function createStore(testRoot: string): ArtifactStore {
  return new ArtifactStore({
    stateDir: join(testRoot, "state"),
    artifactRoot: join(testRoot, "artifacts"),
    artifactMaxFileBytes: 100 * 1024 * 1024,
    artifactMaxTotalBytes: 1024 * 1024 * 1024,
    artifactDefaultTtlHours: 24,
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectArtifactError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
