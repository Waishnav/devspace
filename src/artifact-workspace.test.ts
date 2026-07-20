import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyArtifactToWorkspace } from "./artifact-workspace.js";
import { ArtifactStore } from "./artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-workspace-test-"));

try {
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const store = new ArtifactStore({
    stateDir: join(root, "state"),
    artifactRoot: join(root, "artifacts"),
    artifactMaxFileBytes: 1024 * 1024,
    artifactMaxTotalBytes: 4 * 1024 * 1024,
    artifactDefaultTtlHours: 24,
  });
  try {
    const bytes = Buffer.from("native ChatGPT artifact bytes\u0000\xff", "latin1");
    const upload = await store.beginUpload("client-a", {
      filename: "generated.png",
      mimeType: "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await store.uploadChunk("client-a", {
      uploadId: upload.uploadId,
      offset: 0,
      dataBase64: bytes.toString("base64"),
    });
    const artifact = await store.commitUpload("client-a", upload.uploadId, {
      source: "incoming:openai-file",
    });

    const destination = join(workspaceRoot, "assets", "generated.png");
    const copied = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_test",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "error",
    });

    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(copied.path, destination);
    assert.equal(copied.sha256, artifact.sha256);
    assert.equal(copied.renamed, false);

    await writeFile(destination, "existing");
    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_test",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination,
        onConflict: "error",
      }),
      "workspace_destination_exists",
    );
    assert.equal(await readFile(destination, "utf8"), "existing");

    const renamed = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_test",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "rename",
    });
    assert.equal(renamed.path, join(workspaceRoot, "assets", "generated (1).png"));
    assert.equal(renamed.renamed, true);
    assert.deepEqual(await readFile(renamed.path), bytes);

    const replaced = await copyArtifactToWorkspace({
      store,
      clientId: "client-a",
      workspaceId: "ws_test",
      workspaceRoot,
      artifactId: artifact.artifactId,
      destination,
      onConflict: "replace",
    });
    assert.equal(replaced.path, destination);
    assert.equal(replaced.renamed, false);
    assert.deepEqual(await readFile(destination), bytes);

    await expectArtifactError(
      copyArtifactToWorkspace({
        store,
        clientId: "client-a",
        workspaceId: "ws_test",
        workspaceRoot,
        artifactId: artifact.artifactId,
        destination: join(workspaceRoot, "..", "outside.png"),
        onConflict: "error",
      }),
      "workspace_path_escape",
    );

    if (process.platform !== "win32") {
      const outsideRoot = join(root, "outside");
      await mkdir(outsideRoot, { recursive: true });
      const linkedParent = join(workspaceRoot, "linked-parent");
      await symlink(outsideRoot, linkedParent, "dir");
      await expectArtifactError(
        copyArtifactToWorkspace({
          store,
          clientId: "client-a",
          workspaceId: "ws_test",
          workspaceRoot,
          artifactId: artifact.artifactId,
          destination: join(linkedParent, "escaped.png"),
          onConflict: "error",
        }),
        "workspace_parent_unsafe",
      );
      const linkedDestination = join(workspaceRoot, "linked.png");
      await symlink(join(outsideRoot, "outside.png"), linkedDestination);
      await expectArtifactError(
        copyArtifactToWorkspace({
          store,
          clientId: "client-a",
          workspaceId: "ws_test",
          workspaceRoot,
          artifactId: artifact.artifactId,
          destination: linkedDestination,
          onConflict: "replace",
        }),
        "workspace_destination_unsafe",
      );
    }
  } finally {
    store.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && "code" in error && error.code === code,
  );
}
