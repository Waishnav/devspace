import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ArtifactError } from "./artifact-error.js";
import {
  IncomingArtifactAdapterRegistry,
  createOpenAIIncomingArtifactAdapter,
  describeIncomingArtifactValue,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

await testRegistryFailsClosed();
await testOpenAIFileAdapter();
testLogShapeRedaction();

async function testRegistryFailsClosed(): Promise<void> {
  const registry = new IncomingArtifactAdapterRegistry();
  await expectArtifactError(
    registry.open("https://example.com/untrusted.bin"),
    "unsupported_incoming_artifact",
  );
  await expectArtifactError(
    registry.open("/tmp/local-file.bin"),
    "unsupported_incoming_artifact",
  );
  await expectArtifactError(
    registry.open(Buffer.from("raw bytes")),
    "unsupported_incoming_artifact",
  );

  const ambiguous: IncomingArtifactAdapter = {
    id: "ambiguous",
    canHandle: () => true,
    async open() {
      return { name: "a.bin", stream: Readable.from(["a"]) };
    },
  };
  const ambiguousRegistry = new IncomingArtifactAdapterRegistry([
    ambiguous,
    { ...ambiguous, id: "ambiguous-two" },
  ]);
  await expectArtifactError(
    ambiguousRegistry.open({ native: true }),
    "ambiguous_incoming_artifact",
  );

  assert.throws(
    () => new IncomingArtifactAdapterRegistry([{ ...ambiguous, id: "UPPER" }]),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_incoming_adapter",
  );
  assert.throws(
    () => new IncomingArtifactAdapterRegistry([ambiguous, ambiguous]),
    (error: unknown) => error instanceof ArtifactError && error.code === "duplicate_incoming_adapter",
  );
}

async function testOpenAIFileAdapter(): Promise<void> {
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
  assert.equal(requested.length, 2);

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
    registry.open({
      ...reference,
      download_url: "http://files.oaiusercontent.com/file_123/download",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "https://example.com/file_123/download",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "https://arbitrary.blob.core.windows.net/container/file.png",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      extra: "unexpected",
    }),
    "unsupported_incoming_artifact",
  );

  const redirectRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async (input) => {
        if (String(input).includes("first")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://files.oaiusercontent.com/second?sig=next",
            },
          });
        }
        return new Response(bytes, { status: 200 });
      },
    }),
  ]);
  const redirected = await redirectRegistry.open({
    ...reference,
    download_url: "https://files.oaiusercontent.com/first?sig=initial",
  });
  assert.deepEqual(await collect(redirected.stream), bytes);

  const unsafeRedirectRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/stolen" },
      }),
    }),
  ]);
  await expectArtifactError(
    unsafeRedirectRegistry.open(reference),
    "unsafe_openai_file_reference",
  );

  const failedDownloadRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async () => new Response("nope", { status: 500 }),
    }),
  ]);
  await expectArtifactError(
    failedDownloadRegistry.open(reference),
    "openai_file_download_failed",
  );
}

function testLogShapeRedaction(): void {
  const value = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
    file_id: "file_secret",
    nested: {
      arbitrary: "private-value",
    },
  };
  const serialized = JSON.stringify(describeIncomingArtifactValue(value));
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("private-value"), false);
  assert.equal(serialized.includes("download_url"), true);
  assert.equal(serialized.includes("file_id"), true);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
