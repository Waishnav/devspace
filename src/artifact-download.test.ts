import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  downloadIncomingArtifact,
  isArtifactDownloadSupportedPlatform,
  outgoingArtifactToolLogFields,
  registerArtifactTools,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  exportWorkspaceFile,
  inferMimeType,
  isLikelyBinaryFile,
} from "./outgoing-artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));

try {
  await testToolContracts(join(root, "tool-contracts"));
  testPlatformSupportContract();
  await testWorkspaceFileExport(join(root, "exports"));
  await testWorkspaceFileExportValidation(join(root, "export-validation"));
  if (isArtifactDownloadSupportedPlatform()) {
    await testSafeDownloadAndConflict(join(root, "downloads"));
    await testDestinationValidation(join(root, "destinations"));
    await testSizeLimitAndCleanup(join(root, "size-limit"));
    await testCrashLeftoverCleanup(join(root, "stale-partials"));
    await testSymlinkRejection(join(root, "symlinks"));
    await testPublicationFailurePreservesReplacement(join(root, "publication-race"));
    await testPublishedPermissions(join(root, "permissions"));
  } else {
    await testUnsupportedPlatform(join(root, "unsupported-platform"));
  }
  testLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testToolContracts(testRoot: string): Promise<void> {
  type RegisteredTool = {
    descriptor: Record<string, unknown>;
    callback: (input: Record<string, unknown>) => Promise<unknown>;
  };
  const registered = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      descriptor: Record<string, unknown>,
      callback: RegisteredTool["callback"],
    ) {
      registered.set(name, { descriptor, callback });
      return {};
    },
  };
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(workspaceRoot, "probe.bin"), bytes);
  await writeFile(join(workspaceRoot, "probe.png"), pngBytes);

  registerArtifactTools(server as never, {
    config: {
      artifactMaxFileBytes: 1024,
      logging: { toolCalls: false },
    } as never,
    workspaces: {
      getWorkspace(workspaceId: string) {
        assert.equal(workspaceId, "ws_test");
        return { id: workspaceId, root: workspaceRoot };
      },
    } as never,
  });

  const expectedTools = isArtifactDownloadSupportedPlatform()
    ? ["export_file", "download_artifact"]
    : ["export_file"];
  assert.deepEqual([...registered.keys()], expectedTools);

  const exportDescriptor = registered.get("export_file")?.descriptor;
  assert.ok(exportDescriptor);
  assert.deepEqual(
    Object.keys(exportDescriptor.inputSchema as object).sort(),
    ["mimeType", "path", "workspaceId"],
  );
  assert.deepEqual(
    Object.keys(exportDescriptor.outputSchema as object),
    ["path", "name", "mimeType", "size", "sha256"],
  );
  assert.equal((exportDescriptor.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  assert.equal((exportDescriptor.annotations as { openWorldHint?: boolean }).openWorldHint, false);

  const exportResponse = await registered.get("export_file")?.callback({
    workspaceId: "ws_test",
    path: "probe.bin",
  }) as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
    >;
    structuredContent: Record<string, unknown>;
  };
  assert.equal(exportResponse.content[1]?.type, "resource");
  const resource = exportResponse.content[1];
  assert.equal(resource?.type, "resource");
  if (resource?.type === "resource") {
    assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), bytes);
    assert.equal(resource.resource.mimeType, "application/octet-stream");
    assert.match(resource.resource.uri, /^devspace:\/\/artifact\/[0-9a-f-]+\/probe\.bin$/u);
  }
  assert.equal(exportResponse.structuredContent.name, "probe.bin");
  assert.equal(exportResponse.structuredContent.size, bytes.length);

  const imageResponse = await registered.get("export_file")?.callback({
    workspaceId: "ws_test",
    path: "probe.png",
  }) as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
  };
  assert.equal(imageResponse.content[1]?.type, "image");
  const image = imageResponse.content[1];
  if (image?.type === "image") {
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), pngBytes);
  }

  if (!isArtifactDownloadSupportedPlatform()) return;
  const downloadDescriptor = registered.get("download_artifact")?.descriptor;
  assert.ok(downloadDescriptor);
  assert.deepEqual(downloadDescriptor._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(
    Object.keys(downloadDescriptor.inputSchema as object).sort(),
    ["file", "path", "workspaceId"],
  );
  assert.deepEqual(Object.keys(downloadDescriptor.outputSchema as object), ["path"]);
  assert.equal((downloadDescriptor.annotations as { destructiveHint?: boolean }).destructiveHint, false);

  const fileSchema = (downloadDescriptor.inputSchema as z.ZodRawShape).file as z.ZodType;
  const valid = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  assert.deepEqual(fileSchema.parse(valid), valid);
  assert.throws(() => fileSchema.parse({ file_id: "file_123" }));

  const sensitiveExtraValue = "Bearer should-not-leak";
  const rejected = fileSchema.safeParse({
    ...valid,
    authorization: sensitiveExtraValue,
  });
  assert.equal(rejected.success, false);
  assert.equal(JSON.stringify(rejected).includes(sensitiveExtraValue), false);
}

function testPlatformSupportContract(): void {
  assert.equal(isArtifactDownloadSupportedPlatform("linux"), true);
  assert.equal(isArtifactDownloadSupportedPlatform("darwin"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("freebsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("openbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("netbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("win32"), false);
}

async function testWorkspaceFileExport(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(join(workspaceRoot, "reports"), { recursive: true });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  await writeFile(join(workspaceRoot, "reports", "result.zip"), bytes);

  const exported = await exportWorkspaceFile({
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    path: "reports/result.zip",
  });
  assert.equal(exported.path, "reports/result.zip");
  assert.equal(exported.name, "result.zip");
  assert.equal(exported.mimeType, "application/zip");
  assert.equal(exported.size, bytes.length);
  assert.deepEqual(Buffer.from(exported.blob, "base64"), bytes);
  assert.match(exported.sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.match(exported.uri, /^devspace:\/\/artifact\/[0-9a-f-]+\/result\.zip$/u);

  const overridden = await exportWorkspaceFile({
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    path: "reports/result.zip",
    mimeType: "application/vnd.example.archive",
  });
  assert.equal(overridden.mimeType, "application/vnd.example.archive");
  assert.equal(inferMimeType("document.PDF"), "application/pdf");
  assert.equal(inferMimeType("module.wasm"), "application/wasm");
  assert.equal(inferMimeType("unknown.custom"), "application/octet-stream");
  assert.equal(isLikelyBinaryFile("native.node"), true);
  assert.equal(isLikelyBinaryFile("source.ts"), false);
}

async function testWorkspaceFileExportValidation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const siblingRoot = join(testRoot, "sibling");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(siblingRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "small.bin"), Buffer.from("12345"));
  await writeFile(join(siblingRoot, "outside.bin"), Buffer.from("outside"));

  for (const path of ["../outside.bin", "nested/../outside.bin", "/absolute.bin", "folder/"]) {
    await expectArtifactError(
      exportWorkspaceFile({
        workspaceId: "ws_test",
        workspaceRoot,
        maxFileBytes: 1024,
        path,
      }),
      "artifact_source_invalid",
    );
  }

  await expectArtifactError(
    exportWorkspaceFile({
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      path: "small.bin",
    }),
    "artifact_file_too_large",
  );
  await expectArtifactError(
    exportWorkspaceFile({
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      path: "small.bin",
      mimeType: "invalid",
    }),
    "artifact_mime_type_invalid",
  );
  await expectArtifactError(
    exportWorkspaceFile({
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      path: ".",
    }),
    "artifact_source_invalid",
  );

  if (process.platform !== "win32") {
    await symlink(join(siblingRoot, "outside.bin"), join(workspaceRoot, "escaped.bin"));
    await expectArtifactError(
      exportWorkspaceFile({
        workspaceId: "ws_test",
        workspaceRoot,
        maxFileBytes: 1024,
        path: "escaped.bin",
      }),
      "artifact_source_unsafe",
    );
  }
}

async function testUnsupportedPlatform(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_platform_unsupported",
  );
}

async function testSafeDownloadAndConflict(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const bytes = Buffer.from("native artifact bytes\u0000\xff", "latin1");
  const registry = registryFor({
    name: "../../generated.png",
    size: bytes.length,
    stream: Readable.from([bytes]),
  });

  const first = await downloadIncomingArtifact({
    registry,
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "public/images/generated.png",
  });
  assert.equal(first.path, "public/images/generated.png");
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "replacement.png",
        stream: Readable.from(["replacement"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "public/images/generated.png",
    }),
    "artifact_destination_exists",
  );
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);
  assert.deepEqual(await readdir(workspaceRoot), ["public"]);
}

async function testDestinationValidation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  for (const path of ["../outside.txt", "nested/../outside.txt", "/absolute.txt", "folder/"]) {
    await expectArtifactError(
      downloadIncomingArtifact({
        registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
        workspaceId: "ws_test",
        workspaceRoot,
        maxFileBytes: 1024,
        file: { native: true },
        path,
      }),
      "artifact_destination_invalid",
    );
  }
}

async function testSizeLimitAndCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "too-large.bin",
        size: 5,
        stream: Readable.from([Buffer.from("12345")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "too-large.bin",
    }),
    "artifact_file_too_large",
  );

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "stream-too-large.bin",
        stream: Readable.from([Buffer.from("123"), Buffer.from("45")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "stream-too-large.bin",
    }),
    "artifact_file_too_large",
  );

  assert.deepEqual(await readdir(workspaceRoot), []);
}

async function testCrashLeftoverCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await downloadIncomingArtifact({
    registry: registryFor({ name: "first.txt", stream: Readable.from(["first"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/first.txt",
  });

  const destinationDirectory = join(workspaceRoot, "downloads");
  const stalePartial = join(destinationDirectory, ".devspace-download-stale.partial");
  const recentPartial = join(destinationDirectory, ".devspace-download-recent.partial");
  const unrelated = join(destinationDirectory, "keep-me.partial");
  await writeFile(stalePartial, "stale");
  await writeFile(recentPartial, "recent");
  await writeFile(unrelated, "unrelated");
  const old = new Date(Date.now() - (48 * 60 * 60 * 1_000));
  await utimes(stalePartial, old, old);

  await downloadIncomingArtifact({
    registry: registryFor({ name: "second.txt", stream: Readable.from(["second"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/second.txt",
  });

  const entries = await readdir(destinationDirectory);
  assert.equal(entries.includes(".devspace-download-stale.partial"), false);
  assert.equal(entries.includes(".devspace-download-recent.partial"), true);
  assert.equal(entries.includes("keep-me.partial"), true);
  assert.equal(entries.includes("first.txt"), true);
  assert.equal(entries.includes("second.txt"), true);
}

async function testSymlinkRejection(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const outside = join(testRoot, "outside");
  await mkdir(outside, { recursive: true, mode: 0o700 });

  const linkedWorkspaceRoot = join(testRoot, "linked-workspace");
  await symlink(outside, linkedWorkspaceRoot, "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedWorkspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_workspace_unsafe",
  );

  const linkedDestinationRoot = join(testRoot, "linked-destination-workspace");
  await mkdir(linkedDestinationRoot, { recursive: true });
  await symlink(outside, join(linkedDestinationRoot, "assets"), "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedDestinationRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "assets/blocked.txt",
    }),
    "artifact_destination_parent_unsafe",
  );
}

async function testPublicationFailurePreservesReplacement(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const destinationPath = join(workspaceRoot, "generated.txt");

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "generated.txt",
        stream: Readable.from(["downloaded"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "generated.txt",
      publishLink: async (partialPath, candidatePath) => {
        await link(partialPath, candidatePath);
        await unlink(candidatePath);
        await writeFile(candidatePath, "replacement");
      },
    }),
    "artifact_destination_publish_failed",
  );

  assert.equal(await readFile(destinationPath, "utf8"), "replacement");
  assert.deepEqual(await readdir(workspaceRoot), ["generated.txt"]);
}

async function testPublishedPermissions(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const previousUmask = process.umask(0o077);
  try {
    await downloadIncomingArtifact({
      registry: registryFor({
        name: "private.txt",
        stream: Readable.from(["private"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "private.txt",
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(join(workspaceRoot, "private.txt"))).mode & 0o777, 0o600);
}

function testLogRedaction(): void {
  const fields = artifactToolLogFields({
    file: {
      download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
      file_id: "file_secret",
      file_name: "generated.png",
      authorization: "Bearer log-secret",
    },
    workspaceId: "ws_secret",
    path: "private/generated.png",
  });
  const serialized = JSON.stringify(fields);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("log-secret"), false);
  assert.equal(serialized.includes("ws_secret"), true);
  assert.equal(serialized.includes("files.oaiusercontent.com"), true);

  const outgoingFields = outgoingArtifactToolLogFields({
    workspaceId: "ws_export",
    path: "reports/archive.zip",
    mimeType: "application/zip",
    blob: "must-not-be-logged",
  });
  const outgoingSerialized = JSON.stringify(outgoingFields);
  assert.equal(outgoingSerialized.includes("must-not-be-logged"), false);
  assert.equal(outgoingSerialized.includes("ws_export"), true);
  assert.equal(outgoingSerialized.includes("reports/archive.zip"), true);
}

function registryFor(source: {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}): IncomingArtifactAdapterRegistry {
  const adapter: IncomingArtifactAdapter = {
    id: "test-native",
    canHandle: () => true,
    async open() {
      return source;
    },
  };
  return new IncomingArtifactAdapterRegistry([adapter]);
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
