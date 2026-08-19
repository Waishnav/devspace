import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";

test("stateless MCP stays usable across fresh clients", async (t) => {
  await ensureUiBuildFixture(t);
  const fixture = await startFixture(true);
  t.after(() => cleanupFixture(fixture));

  for (let index = 0; index < 40; index += 1) {
    const initialized = await postMcp(
      fixture,
      initializeRequest(index * 2 + 1, "stateless-test"),
    );
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get("mcp-session-id"), null);

    const resource = await postMcp(
      fixture,
      {
        jsonrpc: "2.0",
        id: index * 2 + 2,
        method: "resources/read",
        params: { uri: WORKSPACE_APP_URI },
      },
      { "mcp-protocol-version": PROTOCOL_VERSION },
    );
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("mcp-session-id"), null);
    assert.match(await resource.text(), /ui:\/\/devspace\/workspace-app\.html/);
  }

  const transport = new StreamableHTTPClientTransport(new URL(fixture.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
  });
  const client = new Client({ name: "stateless-sdk-test", version: "1.0.0" });
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  assert.equal((await client.readResource({ uri: WORKSPACE_APP_URI })).contents.length, 1);
  await client.close();
});

test("shutdown waits for request-scoped MCP cleanup", async (t) => {
  const fixture = await startFixture();
  const originalClose = McpServer.prototype.close;
  const started = deferred();
  const release = deferred();
  McpServer.prototype.close = async function patchedClose() {
    started.resolve();
    await release.promise;
    await originalClose.call(this);
  };
  t.after(async () => {
    McpServer.prototype.close = originalClose;
    release.resolve();
    await cleanupFixture(fixture);
  });

  const initialized = await postMcp(fixture, initializeRequest(1, "shutdown-test"));
  assert.equal(initialized.status, 200);
  await initialized.text();
  await started.promise;

  const shutdown = trackedShutdown(fixture.running.close());
  await nextTurn();
  assert.equal(shutdown.done(), false);

  const rejected = await postMcp(fixture, initializeRequest(2, "shutdown-rejected"));
  assert.equal(rejected.status, 503);
  assert.match(await rejected.text(), /Server is shutting down/);

  release.resolve();
  await shutdown.promise;
});

test("shutdown waits for in-flight authentication", async (t) => {
  const fixture = await startFixture();
  const originalVerify = SingleUserOAuthProvider.prototype.verifyAccessToken;
  const started = deferred();
  const release = deferred();
  SingleUserOAuthProvider.prototype.verifyAccessToken = async function patchedVerify(token) {
    started.resolve();
    await release.promise;
    return originalVerify.call(this, token);
  };
  t.after(async () => {
    SingleUserOAuthProvider.prototype.verifyAccessToken = originalVerify;
    release.resolve();
    await cleanupFixture(fixture);
  });

  const request = postMcp(fixture, initializeRequest(1, "auth-shutdown-test"));
  await started.promise;
  const shutdown = trackedShutdown(fixture.running.close());
  await nextTurn();
  assert.equal(shutdown.done(), false);

  release.resolve();
  const response = await request;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Server is shutting down/);
  await shutdown.promise;
});

test("shutdown waits for in-flight tool handlers", async (t) => {
  const fixture = await startFixture();
  const originalOpenWorkspace = WorkspaceRegistry.prototype.openWorkspace;
  const started = deferred();
  const release = deferred();
  WorkspaceRegistry.prototype.openWorkspace = async function patchedOpenWorkspace(input, options) {
    started.resolve();
    await release.promise;
    return originalOpenWorkspace.call(this, input, options);
  };
  t.after(async () => {
    WorkspaceRegistry.prototype.openWorkspace = originalOpenWorkspace;
    release.resolve();
    await cleanupFixture(fixture);
  });

  const toolRequest = postMcp(
    fixture,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: fixture.project } },
    },
    { "mcp-protocol-version": PROTOCOL_VERSION },
  ).catch(() => undefined);
  await started.promise;

  const shutdown = trackedShutdown(fixture.running.close());
  await nextTurn();
  assert.equal(shutdown.done(), false);
  release.resolve();
  await shutdown.promise;
  await toolRequest;
});

type Fixture = Awaited<ReturnType<typeof startFixture>>;

async function startFixture(widgets = false) {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const publicBaseUrl = "http://127.0.0.1:1";
  const token = "stateless-mcp-test-access-token";
  await mkdir(project);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_LOG_LEVEL: "silent",
    ...(widgets ? { DEVSPACE_WIDGETS: "changes" } : {}),
    PORT: "1",
  });
  authorizeToken(stateDir, publicBaseUrl, token);
  const running = createServer(config);

  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  return {
    root,
    project,
    token,
    running,
    httpServer,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await close(fixture.httpServer);
  await fixture.running.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function initializeRequest(id: number, name: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
    },
  };
}

function postMcp(
  fixture: Fixture,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(fixture.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function authorizeToken(stateDir: string, publicBaseUrl: string, token: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = store.registerClient(
    {
      client_name: "Stateless MCP Test",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    ["127.0.0.1"],
  );
  store.saveAccessToken(createHash("sha256").update(token).digest("base64url"), {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: resourceUrlFromServerUrl(new URL("/mcp", publicBaseUrl)).href,
  });
  store.close();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function trackedShutdown(promise: Promise<void>) {
  let finished = false;
  return {
    promise: promise.then(() => { finished = true; }),
    done: () => finished,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function ensureUiBuildFixture(t: TestContext): Promise<void> {
  const uiRoot = join(process.cwd(), "dist", "ui");
  const manifestPath = join(uiRoot, ".vite", "manifest.json");
  if (existsSync(manifestPath)) return;

  const scriptPath = join(uiRoot, "assets", "workspace-app-stateless-test.js");
  const stylesheetPath = join(uiRoot, "assets", "workspace-app-stateless-test.css");
  t.after(async () => {
    await Promise.all([
      rm(manifestPath, { force: true }),
      rm(scriptPath, { force: true }),
      rm(stylesheetPath, { force: true }),
    ]);
  });

  await mkdir(join(uiRoot, ".vite"), { recursive: true });
  await mkdir(join(uiRoot, "assets"), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    "workspace-app.html": {
      file: "assets/workspace-app-stateless-test.js",
      css: ["assets/workspace-app-stateless-test.css"],
    },
  }));
  await writeFile(scriptPath, "export {};\n");
  await writeFile(stylesheetPath, "/* stateless MCP test fixture */\n");
}

function listen(app: ReturnType<typeof createServer>["app"]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
