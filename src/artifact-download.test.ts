import { unsafeNarrow } from "./unsafe-narrow.js";
import type { JsonObject, WireInput } from "./json-value.js";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  downloadIncomingArtifact,
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import { parseSafeWindowsArtifactRelativePath } from "./artifact-path-windows.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

const requiresDownloadSupport = { skip: !isArtifactDownloadSupportedPlatform() };

test("artifact tools register only download_artifact with a strict file schema", testOneToolContract);

test("artifact downloads are supported on Linux, macOS, and Windows only", testPlatformSupportContract);

test("Windows artifact paths reject unsafe forms and normalize separators", testWindowsPathValidationContract);

test("a download is written once and never overwrites an existing destination", requiresDownloadSupport, async (t) => {
  await testSafeDownloadAndConflict(await fixture(t, "downloads"));
});

test("download destinations outside the workspace or naming a directory are invalid", requiresDownloadSupport, async (t) => {
  await testDestinationValidation(await fixture(t, "destinations"));
});

test("oversized downloads are rejected and leave no partial files", requiresDownloadSupport, async (t) => {
  await testSizeLimitAndCleanup(await fixture(t, "size-limit"));
});

test("stale download partials are removed while recent and unrelated files stay", requiresDownloadSupport, async (t) => {
  await testCrashLeftoverCleanup(await fixture(t, "stale-partials"));
});

test("linked workspaces and destination parents are rejected", requiresDownloadSupport, async (t) => {
  await testSymlinkRejection(await fixture(t, "symlinks"));
});

test("a failed publication keeps a concurrently created destination", requiresDownloadSupport, async (t) => {
  await testPublicationFailurePreservesReplacement(await fixture(t, "publication-race"));
});

test("published downloads are private to the user", requiresDownloadSupport, async (t) => {
  await testPublishedPermissions(await fixture(t, "permissions"));
});

test("artifact tool logs redact file secrets", testLogRedaction);

async function fixture(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  return join(root, name);
}

function testOneToolContract(): void {
  const registered = new Map<string, { descriptor: JsonObject; callback: (input: never) => WireInput }>();

  const server = {
    registerTool(
      name: string,
      descriptor: JsonObject,
      callback: (input: never) => WireInput,
    ) {
      registered.set(name, { descriptor, callback });

      return {};
    },
  };

  // SAFETY: The surrounding checks or construction already match this type.
  registerArtifactTools(server as never, {
    // SAFETY: The surrounding checks or construction already match this type.
    config: {
      artifactMaxFileBytes: 1024,
      logging: { toolCalls: false },
    } as never,
    // SAFETY: The surrounding checks or construction already match this type.
    workspaces: {} as never,
  });

  assert.deepEqual([...registered.keys()], ["download_artifact"]);
  const descriptor = registered.get("download_artifact")?.descriptor;
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });
  // SAFETY: The surrounding checks or construction already match this type.
  assert.deepEqual(Object.keys(descriptor.inputSchema as object).sort(), ["file", "path", "workspace_id"]);
  // SAFETY: The surrounding checks or construction already match this type.
  assert.deepEqual(Object.keys(descriptor.outputSchema as object), ["path"]);
  // SAFETY: The surrounding checks or construction already match this type.
  assert.equal((descriptor.annotations as { destructiveHint?: boolean }).destructiveHint, false);

  assert.ok(descriptor.inputSchema);
  const fileSchema = unsafeNarrow<{ file: z.ZodType }>(descriptor.inputSchema).file;

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
  assert.equal(isArtifactDownloadSupportedPlatform("darwin"), true);
  assert.equal(isArtifactDownloadSupportedPlatform("freebsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("openbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("netbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("win32"), true);
}

function testWindowsPathValidationContract(): void {
  for (const path of [
    "../outside.txt",
    "C:drive-relative.txt",
    "C:\\absolute.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\file.txt",
    "file.txt:stream",
    "CON",
    "con.txt",
    "CLOCK$",
    "COM¹.txt",
    "LPT³.log",
    "folder/trailing-dot.",
    "folder/trailing-space ",
    "folder/invalid?.txt",
  ]) {
    assert.equal(parseSafeWindowsArtifactRelativePath(path), undefined, path);
  }

  assert.deepEqual(parseSafeWindowsArtifactRelativePath("assets\\icons/lovely.png"), {
    path: "assets/icons/lovely.png",
    parts: ["assets", "icons", "lovely.png"],
    name: "lovely.png",
  });
  assert.deepEqual(parseSafeWindowsArtifactRelativePath("画像/アイコン.png"), {
    path: "画像/アイコン.png",
    parts: ["画像", "アイコン.png"],
    name: "アイコン.png",
  });
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

  const invalidPaths = ["../outside.txt", "nested/../outside.txt", "/absolute.txt", "folder/"];

  if (process.platform === "win32") {
    invalidPaths.push(
      "C:drive-relative.txt",
      "C:\\absolute.txt",
      "\\\\server\\share\\file.txt",
      "file.txt:stream",
      "CON.txt",
      "folder/trailing-dot.",
      "folder/trailing-space ",
    );
  }

  for (const path of invalidPaths) {
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

  if (process.platform !== "win32") await chmod(stalePartial, 0o000);

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
  const outside = join(testRoot, "outside");
  await mkdir(outside, { recursive: true, mode: 0o700 });

  const linkedWorkspaceRoot = join(testRoot, "linked-workspace");
  await symlink(outside, linkedWorkspaceRoot, process.platform === "win32" ? "junction" : "dir");
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
  await symlink(
    outside,
    join(linkedDestinationRoot, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
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
      publishEntry: async (directory, partialName, candidateName) => {
        await directory.link(partialName, candidateName);
        await directory.unlink(candidateName);
        const replacement = await directory.createExclusiveFile(candidateName, 0o600);

        try {
          await replacement.writeAll(Buffer.from("replacement"), 0);
          await replacement.sync();
        } finally {
          await replacement.close();
        }
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

  const published = await stat(join(workspaceRoot, "private.txt"));
  assert.equal(published.isFile(), true);

  if (process.platform !== "win32") {
    assert.equal(published.mode & 0o777, 0o600);
  }
}

function testLogRedaction(): void {
  const fields = artifactToolLogFields({
    file: {
      download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
      file_id: "file_secret",
      file_name: "generated.png",
      authorization: "Bearer log-secret",
    },
    workspace_id: "ws_secret",
    path: "private/generated.png",
  });

  const serialized = JSON.stringify(fields);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("log-secret"), false);
  assert.equal(serialized.includes("ws_secret"), true);
  assert.equal(serialized.includes("files.oaiusercontent.com"), true);
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

async function expectArtifactError(promise: Promise<WireInput>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: WireInput) => error instanceof ArtifactError && error.code === code,
  );
}
