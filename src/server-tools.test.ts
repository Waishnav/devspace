import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOpenAIIncomingArtifactAdapter } from "./incoming-artifacts.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer, type LocalControlAdapters } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { ServerConfig } from "./config.js";
import type { CodexComputerUseInput } from "./codex-computer-use.js";
import type { CodexMcpToolResult } from "./codex-mcp-client.js";
import type { CodexExecutionContext } from "./codex-request-context.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-tools-test-"));
const stateDir = join(root, "state");
const worktreeRoot = join(root, "worktrees");
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "server-tools-test-owner-token",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: ["localhost"],
  },
  allowedRoots: [root],
  allowedHosts: ["localhost", "127.0.0.1"],
  publicBaseUrl: "http://127.0.0.1:7676",
  toolMode: "codex",
  widgets: "changes",
  stateDir,
  worktreeRoot,
  artifactsEnabled: true,
  artifactMaxFileBytes: 10 * 1024 * 1024,
  computerUseEnabled: true,
  computerUseBackend: "codex",
  chromeDefaultProfile: "Default",
  skillsEnabled: false,
  skillPaths: [],
  devspaceSkillsDir: join(root, "skills"),
  devspaceAgentsDir: join(root, "agents"),
  subagents: false,
  agentDir: join(root, ".codex"),
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  },
};

await writeFile(join(root, "patch-source.txt"), "old\n");
await writeFile(join(root, "patch-delete.txt"), "remove\n");

const workspaceStore = createWorkspaceStore(stateDir);
const workspaces = new WorkspaceRegistry(config, workspaceStore);
const workspaceId = (await workspaces.openWorkspace(root)).workspace.id;
const processSessions = new ProcessSessionManager();
const emptyResult: CodexMcpToolResult = {
  content: [{ type: "text", text: "test" }],
  isError: false,
};
const localControls: LocalControlAdapters = {
  computerUse: {
    invoke: async (
      input: CodexComputerUseInput,
      context: CodexExecutionContext,
    ): Promise<CodexMcpToolResult> => {
      if (input.action !== "get_app_state") return emptyResult;
      const response = await context.onElicitation?.({
        message: "Allow ChatGPT to use Finder?",
        requestedSchema: { type: "object", properties: {} },
      });
      if (response?.action !== "accept") {
        return {
          content: [{ type: "text", text: "Application approval declined." }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: "Finder accessibility tree" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        isError: false,
      };
    },
    close: async () => undefined,
  } as never,
  chromeUse: {
    invoke: async () => emptyResult,
    close: async () => undefined,
  } as never,
};
const server = createMcpServer(
  config,
  workspaces,
  createReviewCheckpointManager(),
  processSessions,
  [],
  [createOpenAIIncomingArtifactAdapter()],
  localControls,
);
const client = new Client(
  { name: "devspace-tool-list-test", version: "1" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    [
      "apply_patch",
      "chrome_use",
      "computer_use",
      "exec_command",
      "export_file",
      "open_workspace",
      "read",
      "show_changes",
      "write_stdin",
    ].sort(),
  );
  for (const hidden of ["write", "edit", "bash", "capture_screen", "computer_action"]) {
    assert.equal(names.includes(hidden), false);
  }
  const chromeUseTool = result.tools.find((tool) => tool.name === "chrome_use");
  assert.ok(chromeUseTool);
  assert.match(chromeUseTool.description ?? "", /devspace-chrome-use/u);
  assert.match(chromeUseTool.description ?? "", /open_workspace/u);
  const chromeInputSchema = chromeUseTool.inputSchema as {
    properties?: Record<string, { enum?: unknown[] }>;
  };
  assert.ok(chromeInputSchema.properties?.profile);
  assert.ok(chromeInputSchema.properties?.action?.enum?.includes("list_profiles"));

  const patchResult = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: `*** Begin Patch
*** Add File: patch-added.txt
+added
*** Update File: patch-source.txt
*** Move to: moved/patch-source.txt
@@
-old
+updated
*** Delete File: patch-delete.txt
*** End Patch`,
    },
  });
  assert.notEqual(patchResult.isError, true);
  assert.deepEqual(
    (patchResult.structuredContent as {
      files: Array<{ path: string; previousPath?: string; operation: string }>;
    }).files,
    [
      { path: "patch-added.txt", operation: "add" },
      {
        path: "moved/patch-source.txt",
        previousPath: "patch-source.txt",
        operation: "move",
      },
      { path: "patch-delete.txt", operation: "delete" },
    ],
  );
  assert.equal(await readFile(join(root, "patch-added.txt"), "utf8"), "added\n");
  assert.equal(await readFile(join(root, "moved/patch-source.txt"), "utf8"), "updated\n");
  await assert.rejects(readFile(join(root, "patch-delete.txt"), "utf8"), /ENOENT/u);

  const nodeCommand = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const commandResult = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${nodeCommand} -e "console.log('exec-ok')"`,
      yieldTimeMs: 2_000,
    },
  });
  assert.notEqual(commandResult.isError, true);
  const commandSummary = commandResult.structuredContent as {
    running: boolean;
    exitCode?: number;
    result: string;
  };
  assert.equal(commandSummary.running, false);
  assert.equal(commandSummary.exitCode, 0);
  assert.match(commandSummary.result, /exec-ok/u);

  const interactiveResult = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${nodeCommand} -e "process.stdin.once('data', data => { console.log('stdin:' + data.toString().trim()); process.exit(0); })"`,
      yieldTimeMs: 5,
    },
  });
  const interactiveSummary = interactiveResult.structuredContent as {
    running: boolean;
    sessionId?: number;
  };
  assert.equal(interactiveSummary.running, true);
  assert.ok(interactiveSummary.sessionId);
  const stdinResult = await client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: interactiveSummary.sessionId,
      chars: "hello\n",
      yieldTimeMs: 2_000,
    },
  });
  const stdinSummary = stdinResult.structuredContent as {
    running: boolean;
    exitCode?: number;
    result: string;
  };
  assert.equal(stdinSummary.running, false);
  assert.equal(stdinSummary.exitCode, 0);
  assert.match(stdinSummary.result, /stdin:hello/u);

  const computerUseTool = result.tools.find((tool) => tool.name === "computer_use");
  assert.ok(computerUseTool);
  const computerUseInputSchema = computerUseTool.inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(computerUseInputSchema.properties?.elicitationAction);

  const approval = await client.callTool({
    name: "computer_use",
    arguments: {
      workspaceId,
      action: "get_app_state",
      app: "Finder",
    },
  });
  assert.equal(approval.isError, false);
  const approvalSummary = approval.structuredContent as Record<string, unknown>;
  assert.equal(approvalSummary.approvalRequired, true);
  assert.equal(approvalSummary.approvalMessage, "Allow ChatGPT to use Finder?");

  const accepted = await client.callTool({
    name: "computer_use",
    arguments: {
      workspaceId,
      action: "get_app_state",
      app: "Finder",
      elicitationAction: "accept",
    },
  });
  assert.equal(accepted.isError, false);
  const acceptedContent = accepted.content as Array<{ type: string; text?: string }>;
  assert.equal(acceptedContent.some((item) => item.type === "image"), true);
  assert.match(
    acceptedContent.find((item) => item.type === "text")?.text ?? "",
    /Finder accessibility tree/u,
  );
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  processSessions.shutdown();
  workspaceStore.close?.();
  await rm(root, { recursive: true, force: true });
}
