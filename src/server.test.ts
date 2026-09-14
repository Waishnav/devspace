import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { z, type JSONType } from "zod";

const execFileAsync = promisify(execFile);

const jsonValue = z.json();

const structuredSchema = z.object({
  workspace_id: z.string().optional(),
  review_ref: z.string().optional(),
  review: z.object({ available: z.boolean() }).optional(),
  result: z.string().optional(),
  instruction: z.string().optional(),
  agent_providers: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), note: z.string().optional() })).optional(),
  agents: z.array(z.object({ name: z.string().optional() })).optional(),
  skills: z.array(z.object({ name: z.string().optional() })).optional(),
  agents_files: z.array(jsonValue).optional(),
  available_agents_files: z.array(jsonValue).optional(),
  skill_diagnostics: z.array(jsonValue).optional(),
}).passthrough();

const cardSchema = z.object({
  summary: z.object({ files: z.number().optional(), additions: z.number().optional(), removals: z.number().optional() }).optional(),
  files: z.array(z.object({ path: z.string(), type: z.string(), additions: z.number(), removals: z.number() })).optional(),
  payload: z.object({ patch: z.string().optional() }).optional(),
  workspaceReused: z.boolean().optional(),
  includeBootstrapContext: z.boolean().optional(),
  agentsFiles: z.array(jsonValue).optional(),
  availableAgentsFiles: z.array(jsonValue).optional(),
  skills: z.array(jsonValue).optional(),
  agentProviders: z.array(z.object({ note: z.string().optional() })).optional(),
  agents: z.array(z.unknown()).optional(),
}).passthrough();

const metadataSchema = z.object({ card: cardSchema.optional(), ui: jsonValue.optional() }).passthrough();

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  maximum?: number;
  description?: string;
}

const schemaNode: z.ZodType<JsonSchemaNode> = z.object({
  properties: z.record(z.string(), z.lazy(() => schemaNode)).optional(),
  items: z.lazy(() => schemaNode).optional(),
  anyOf: z.array(z.lazy(() => schemaNode)).optional(),
  oneOf: z.array(z.lazy(() => schemaNode)).optional(),
  allOf: z.array(z.lazy(() => schemaNode)).optional(),
  maximum: z.number().optional(),
  description: z.string().optional(),
});

const discoveryBodySchema = z.object({ result: z.object({ supportedVersions: z.array(z.string()).optional() }).optional() });

const toolsListBodySchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string().optional() })).optional() }).optional() });

const callBodySchema = z.object({ result: z.object({ structuredContent: structuredSchema.optional() }).optional() });

const clientBodySchema = z.object({ client_id: z.string().optional() });

const tokenBodySchema = z.object({ access_token: z.string().optional() });

const mcpParamsSchema = z.object({ name: z.string().optional(), uri: z.string().optional(), _meta: z.record(z.string(), jsonValue).optional() }).passthrough();

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "show_changes"],
    },
    {
      mode: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "show_changes"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const tools = await context.client.listTools();

      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema ? schemaNode.parse(tool.inputSchema) : undefined)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema ? schemaNode.parse(tool.outputSchema) : undefined)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools bound model-facing yield windows to 12 seconds", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);

    const yieldSchema = schemaNode.parse(tool?.inputSchema).properties?.yield_time_ms;

    assert.equal(yieldSchema?.maximum, 12_000);
    assert.match(yieldSchema?.description ?? "", /maximum 12000/i);
  }
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });

  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;

  z.string().parse(workspaceId);

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });

  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));

  assert.match(z.string().parse(shell.result), /nested/i);
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();

      const toolsWithUi = tools.tools
        .filter((tool) => Boolean(metadataSchema.parse(tool._meta ?? {}).ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.ok(plainReview);
  assert.equal(plainReview.available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });

  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );

  const workspaceId = opened.workspace_id;
  z.string().parse(workspaceId);

  await writeFile(join(context.project, "README.md"), "goodbye\n");

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });

  const structured = structuredContent(review);
  assert.equal(metadataSchema.parse(review._meta ?? {}).tool, undefined);

  assert.equal(structured.workspace_id, workspaceId);
  assert.equal("workspaceId" in structured, false);
  assert.match(z.string().parse(structured.review_ref), /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    card.payload?.patch ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();

  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;

  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.ok(outputProperties && "review_ref" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);

  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;

  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });

  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspace_id;

  z.string().parse(workspaceId);

  await writeFile(join(context.project, "README.md"), "first\n");

  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));

  const reviewRef = first.review_ref;
  z.string().parse(reviewRef);

  await writeFile(join(context.project, "README.md"), "second\n");

  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  });

  assert.equal(structuredContent(reopened).review_ref, reviewRef);
  assert.match(
    responseCard(reopened).payload?.patch ?? "",
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });

  assert.match(
    responseCard(current).payload?.patch ?? "",
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";

  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });

  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal(metadataSchema.parse(first._meta ?? {}).tool, undefined);
  assert.equal(metadataSchema.parse(repeated._meta ?? {}).tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = schemaNode.parse(openTool?.outputSchema).properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const providerSchema = schemaNode.parse(outputProperties?.agent_providers);

  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  z.string().parse(firstStructured.workspace_id);
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.ok(Array.isArray(firstStructured.agents_files));
  assert.ok(Array.isArray(firstStructured.available_agents_files));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agent_providers));
  assert.equal(
    firstStructured.agent_providers?.[0]?.id,
    "codex",
  );
  assert.equal(
    firstStructured.agent_providers?.[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skill_diagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.match(z.string().parse(firstStructured.instruction), /workspace_id/);
  assert.match(z.string().parse(repeatedStructured.instruction), /workspace_id/);
  assert.doesNotMatch(z.string().parse(firstStructured.instruction), /workspaceId/);
  assert.doesNotMatch(z.string().parse(repeatedStructured.instruction), /workspaceId/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    card.agentProviders?.[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;

  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agent_providers, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    usable.agent_providers?.[0]?.id,
    "codex",
  );
  assert.equal(
    usable.agents?.[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    opened.agent_providers?.map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills ?? [];
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills ?? [];
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(structuredContent(otherSession).agents_files));
  assert.ok(Array.isArray(structuredContent(unscoped).agents_files));
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );

  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );

  assert.equal(discovery.status, 200, await discovery.clone().text());

  const discoveryBody = discoveryBodySchema.parse(await discovery.json());

  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );

  assert.equal(listed.status, 200, await listed.clone().text());

  const listBody = toolsListBodySchema.parse(await listed.json());

  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );

  assert.equal(called.status, 200, await called.clone().text());

  const callBody = callBodySchema.parse(await called.json());

  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  z.string().parse(workspaceId);

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );

  assert.equal(repeated.status, 200, await repeated.clone().text());

  const repeatedBody = callBodySchema.parse(await repeated.json());

  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });

  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );

  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );

  const openBody = callBodySchema.parse(await opened.json());

  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  z.string().parse(workspaceId);

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");

  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e "${command}"`,
        yield_time_ms: 12_000,
      },
    },
  );

  await waitForFile(join(root, "started"));

  let shutdownFinished = false;

  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

interface ServerFixture {
  client: Client;
  project: string;
}

function schemaPropertyPaths(
  schema: JsonSchemaNode | undefined,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema) return [];

  const paths = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });

  if (schema.items) paths.push(...schemaPropertyPaths(schema.items, `${prefix}[]`));

  for (const variant of [schema.anyOf, schema.oneOf, schema.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }

  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
  }));

  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = z.object({ port: z.number() }).parse(httpServer.address());
  const localBaseUrl = `http://127.0.0.1:${address.port}`;

  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );

  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = options.localAgentProviders instanceof Function
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];

  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));

  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };

  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;

  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    options.localAgentProviders instanceof Function
      ? options.localAgentProviders
      : () => initialProviderAvailability;

  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );

  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);

  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  assert.equal(registration.status, 201, await registration.clone().text());
  const client = clientBodySchema.parse(await registration.json());
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });

  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });

  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = tokenBodySchema.parse(await exchange.json());
  assert.ok(tokens.access_token);

  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: z.infer<typeof mcpParamsSchema>,
): Promise<Response> {
  const mcpName = params.name ?? params.uri;

  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });

  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

  if (mcpName) headers.set("mcp-name", mcpName);

  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: Record<string, JSONType> | undefined): Record<string, JSONType> {
  return z.record(z.string(), jsonValue).parse(value ?? {});
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params: Parameters<Client["callTool"]>[0] = {
    name: "open_workspace",
    arguments: { path },
  };

  if (conversationScopeId) params._meta = { "openai/session": conversationScopeId };

  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): z.infer<typeof structuredSchema> {
  assert.ok(result.structuredContent);

  return structuredSchema.parse(result.structuredContent);
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): z.infer<typeof cardSchema> {
  return cardSchema.parse(metadataSchema.parse(result._meta).card);
}
