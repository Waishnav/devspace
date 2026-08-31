import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response as ExpressResponse } from "express";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, createServer as createDevspaceServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

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

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
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

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspaceId, workspaceId);
  assert.match(structured.reviewRef as string, /^[0-9a-f]{40,64}$/);
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
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspaceId" in outputProperties);
  assert.ok(outputProperties && "reviewRef" in outputProperties);
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
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  const reviewRef = first.reviewRef;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).reviewRef, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
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
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
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
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
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
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
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
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspaceId, structuredContent(first).workspaceId);
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.notEqual(structuredContent(otherSession).workspaceId, structuredContent(first).workspaceId);
  assert.notEqual(structuredContent(unscoped).workspaceId, structuredContent(first).workspaceId);
  assert.ok(Array.isArray(structuredContent(otherSession).agentsFiles));
  assert.ok(Array.isArray(structuredContent(unscoped).agentsFiles));
});

test("HTTP returns 503 when all MCP sessions are active", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-capacity-test-"));
  const configDir = join(root, ".config");
  const stateDir = join(root, ".state");
  const httpServer = createHttpServer();
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig(writeTestDevspaceConfig(configDir, {
    server: {
      host: "127.0.0.1",
      port,
      publicBaseUrl,
      maxMcpSessions: 2,
    },
    storage: { stateDir },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent", requests: false, toolCalls: false },
  }));
  let running: ReturnType<typeof createDevspaceServer> | undefined;
  t.after(async () => {
    await running?.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await rm(root, { recursive: true, force: true });
  });

  const accessToken = await issueTestAccessToken(config);
  running = createDevspaceServer(config, { incomingArtifactAdapters: [] });
  httpServer.on("request", running.app);

  const firstSession = await initializeHttpSession(publicBaseUrl, accessToken, 1);
  const secondSession = await initializeHttpSession(publicBaseUrl, accessToken, 2);
  const firstSse = await openSessionSse(publicBaseUrl, accessToken, firstSession);
  const secondSse = await openSessionSse(publicBaseUrl, accessToken, secondSession);

  try {
    const blocked = await initializeHttpResponse(publicBaseUrl, accessToken, 3);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get("retry-after"), "5");
    const payload = await blocked.json() as {
      error?: { message?: string };
    };
    assert.match(payload.error?.message ?? "", /session limit reached/);
  } finally {
    firstSse.abort();
    secondSse.abort();
  }
});

/** Issue an OAuth access token through the real provider used by the HTTP test. */
async function issueTestAccessToken(config: ServerConfig): Promise<string> {
  await mkdir(config.stateDir, { recursive: true });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const provider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const redirectUri = "http://127.0.0.1/callback";
  assert.ok(provider.clientsStore.registerClient);
  const client: OAuthClientInformationFull = await provider.clientsStore.registerClient({
    redirect_uris: [redirectUri],
    client_name: "HTTP capacity test",
  });
  let redirectLocation: string | undefined;
  const response = {
    req: {
      method: "POST",
      body: { owner_token: config.oauth.ownerToken },
    },
    redirect(status: number, location: string) {
      assert.equal(status, 302);
      redirectLocation = location;
      return response;
    },
  } as unknown as ExpressResponse;

  try {
    await provider.authorize(client, {
      codeChallenge: "http-capacity-test-challenge",
      redirectUri,
      resource: mcpUrl,
      scopes: config.oauth.scopes,
    }, response);
    assert.ok(redirectLocation);
    const code = new URL(redirectLocation).searchParams.get("code");
    assert.ok(code);
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      redirectUri,
      mcpUrl,
    );
    return tokens.access_token;
  } finally {
    provider.close();
  }
}

/** Send one MCP initialize request to the HTTP endpoint. */
async function initializeHttpResponse(
  publicBaseUrl: string,
  accessToken: string,
  id: number,
): Promise<Response> {
  return fetch(`${publicBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-capacity-test", version: "1.0.0" },
      },
    }),
  });
}

/** Initialize one MCP session and send its initialized notification. */
async function initializeHttpSession(
  publicBaseUrl: string,
  accessToken: string,
  id: number,
): Promise<string> {
  const response = await initializeHttpResponse(publicBaseUrl, accessToken, id);
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await response.text();

  const initialized = await fetch(`${publicBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  assert.equal(initialized.status, 202);
  await initialized.text();
  return sessionId;
}

/** Open a live SSE response so the session remains protected from eviction. */
async function openSessionSse(
  publicBaseUrl: string,
  accessToken: string,
  sessionId: string,
): Promise<{ response: Response; abort(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${publicBaseUrl}/mcp`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return {
    response,
    abort: () => controller.abort(),
  };
}

interface ServerFixture {
  client: Client;
  project: string;
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

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: { enabled: options.localAgentProviders !== undefined, providers: [] },
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
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
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

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
