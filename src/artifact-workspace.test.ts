import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  } finally {
    store.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
