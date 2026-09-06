import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ARTIFACT_RESOURCE_MAX_BYTES,
  clearExportedArtifactsForTests,
  exportWorkspaceArtifact,
  readExportedArtifactResource,
  registerArtifactExportTool,
} from "./artifact-export.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";

async function fixture(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "devspace-artifact-export-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  t.after(async () => {
    await clearExportedArtifactsForTests();
    await rm(root, { recursive: true, force: true });
  });
  return { workspace, outside };
}

function workspaceRegistry(root: string): WorkspaceRegistry {
  return {
    getWorkspace(id: string) {
      assert.equal(id, "ws_test");
      return { id, root };
    },
    resolvePath(_workspace: unknown, path: string) {
      return resolve(root, path);
    },
  } as unknown as WorkspaceRegistry;
}

async function connectedServer(root: string) {
  const server = new McpServer({ name: "artifact-export-test", version: "1.0.0" });
  registerArtifactExportTool(server, {
    config: {
      artifactMaxFileBytes: ARTIFACT_RESOURCE_MAX_BYTES,
      logging: { toolCalls: false },
    } as unknown as ServerConfig,
    workspaces: workspaceRegistry(root),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "artifact-export-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("export_artifact materializes through resources/read across MCP sessions", async (t) => {
  const { workspace } = await fixture(t);
  const bytes = Buffer.from("artifact-diagnostic-marker\n", "utf8");
  await writeFile(join(workspace, "note.txt"), bytes);

  const first = await connectedServer(workspace);
  const exported = await first.client.callTool({
    name: "export_artifact",
    arguments: { workspaceId: "ws_test", path: "note.txt" },
  });
  await first.close();

  const content = exported.content as Array<{
    type: string;
    uri?: string;
    name?: string;
    mimeType?: string;
    size?: number;
  }>;
  const link = content.find((item) => item.type === "resource_link");
  assert.ok(link?.uri);
  assert.equal(link.name, "note.txt");
  assert.equal(link.mimeType, "text/plain; charset=utf-8");
  assert.equal(link.size, bytes.length);
  assert.match(link.uri, /^artifact:\/\/devspace\/[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(exported).includes(bytes.toString("base64")), false);

  const second = await connectedServer(workspace);
  const read = await second.client.readResource({ uri: link.uri });
  await second.close();
  assert.deepEqual(read.contents, [{
    uri: link.uri,
    mimeType: "text/plain; charset=utf-8",
    text: bytes.toString("utf8"),
  }]);
});

test("binary resources use MCP blob content", async (t) => {
  const { workspace } = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const filePath = join(workspace, "payload.bin");
  await writeFile(filePath, bytes);

  const exported = await exportWorkspaceArtifact({ workspaceRoot: workspace, filePath });
  const token = exported.uri.split("/").at(-1) ?? "";
  const read = await readExportedArtifactResource(token, exported.uri);
  assert.deepEqual(read.contents, [{
    uri: exported.uri,
    mimeType: "application/octet-stream",
    blob: bytes.toString("base64"),
  }]);
});

test("the exact 8 MiB resource boundary remains exportable", async (t) => {
  const { workspace } = await fixture(t);
  const filePath = join(workspace, "boundary.bin");
  await writeFile(filePath, Buffer.alloc(ARTIFACT_RESOURCE_MAX_BYTES, 0x5a));

  const exported = await exportWorkspaceArtifact({ workspaceRoot: workspace, filePath });
  assert.equal(exported.size, ARTIFACT_RESOURCE_MAX_BYTES);
});

test("files larger than the MCP resource limit are rejected", async (t) => {
  const { workspace } = await fixture(t);
  const filePath = join(workspace, "too-large.bin");
  await writeFile(filePath, Buffer.alloc(ARTIFACT_RESOURCE_MAX_BYTES + 1, 0x5a));

  await assert.rejects(
    exportWorkspaceArtifact({ workspaceRoot: workspace, filePath }),
    /configured MCP resource materialization limit/,
  );
});

test("a lower configured per-file limit is enforced", async (t) => {
  const { workspace } = await fixture(t);
  const filePath = join(workspace, "configured-limit.bin");
  await writeFile(filePath, Buffer.alloc(5));

  await assert.rejects(
    exportWorkspaceArtifact({
      workspaceRoot: workspace,
      filePath,
      maxFileBytes: 4,
    }),
    /configured MCP resource materialization limit/,
  );
});

test("missing sources fail without exposing their absolute path", async (t) => {
  const { workspace } = await fixture(t);
  const filePath = join(workspace, "does-not-exist.txt");

  await assert.rejects(
    exportWorkspaceArtifact({ workspaceRoot: workspace, filePath }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /existing regular file inside the selected workspace/);
      assert.equal(error.message.includes(workspace), false);
      return true;
    },
  );
});

test("symlinks resolving outside the workspace are rejected", async (t) => {
  if (process.platform === "win32") t.skip("symlink fixture differs on Windows");
  const { workspace, outside } = await fixture(t);
  const outsideFile = join(outside, "secret.txt");
  const linkedFile = join(workspace, "linked.txt");
  await writeFile(outsideFile, "secret");
  await symlink(outsideFile, linkedFile);

  await assert.rejects(
    exportWorkspaceArtifact({ workspaceRoot: workspace, filePath: linkedFile }),
    /must resolve to a file inside the selected workspace/,
  );
});

test("expired resources cannot be read", async (t) => {
  const { workspace } = await fixture(t);
  const filePath = join(workspace, "short-lived.txt");
  await writeFile(filePath, "short-lived");
  const exported = await exportWorkspaceArtifact({
    workspaceRoot: workspace,
    filePath,
    ttlMs: 5,
  });
  const token = exported.uri.split("/").at(-1) ?? "";
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));

  await assert.rejects(
    readExportedArtifactResource(token, exported.uri),
    /no longer available/,
  );
});
