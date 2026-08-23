import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

test("the HTTP endpoint advertises OAuth and rejects unauthenticated MCP requests", async (t) => {
  const fixture = await httpFixture(t);

  const metadataResponse = await fetch(
    new URL("/.well-known/oauth-protected-resource/mcp", fixture.baseUrl),
  );
  assert.equal(metadataResponse.status, 200);
  assert.deepEqual(await metadataResponse.json(), {
    resource: fixture.mcpUrl.href,
    authorization_servers: [fixture.baseUrl.href],
    scopes_supported: ["devspace"],
    resource_name: "DevSpace",
  });

  const response = await fetch(fixture.mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "devspace-http-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /resource_metadata=.*\/\.well-known\/oauth-protected-resource\/mcp/,
  );
});

test("the HTTP boundary rejects an untrusted browser origin", async (t) => {
  const fixture = await httpFixture(t);
  const request = (origin: string) => fetch(fixture.mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "devspace-http-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal((await request("https://attacker.example")).status, 403);
  assert.equal((await request(fixture.baseUrl.origin)).status, 401);
});

test("an authenticated MCP client owns one HTTP session through termination", async (t) => {
  const fixture = await httpFixture(t);
  const accessToken = await authorize(fixture);
  const transport = new StreamableHTTPClientTransport(fixture.mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "devspace-http-test", version: "1.0.0" });
  let closed = false;
  const closeClient = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  t.after(closeClient);

  await client.connect(transport);
  const sessionId = transport.sessionId;
  assert.ok(sessionId);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "open_workspace"));

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: fixture.root },
  });
  assert.ok(opened.structuredContent);
  const openedWorkspace = jsonObject(opened.structuredContent);
  assert.equal(typeof openedWorkspace.workspaceId, "string");
  assert.equal(openedWorkspace.root, fixture.root);

  const unauthenticatedSessionResponse = await fetch(fixture.mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      "MCP-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(unauthenticatedSessionResponse.status, 401);

  await transport.terminateSession();
  const staleSessionResponse = await fetch(fixture.mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      "MCP-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
  });
  assert.equal(staleSessionResponse.status, 404);
  assert.match(await staleSessionResponse.text(), /Unknown MCP session/);
});

interface HttpFixture {
  baseUrl: URL;
  mcpUrl: URL;
  root: string;
  running: ReturnType<typeof createServer>;
  httpServer: HttpServer;
}

async function httpFixture(t: TestContext): Promise<HttpFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-test-"));
  const port = await availablePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const mcpUrl = new URL("/mcp", baseUrl);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl.href,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_WIDGETS: "off",
    PORT: String(port),
  });
  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = await listen(running, port);

  t.after(async () => {
    await closeHttpServer(httpServer);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  return { baseUrl, mcpUrl, root, running, httpServer };
}

async function authorize(fixture: HttpFixture): Promise<string> {
  const redirectUri = new URL("/oauth-callback", fixture.baseUrl).href;
  const registrationResponse = await fetch(new URL("/register", fixture.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace HTTP test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = jsonObject(await registrationResponse.json());
  const clientId = stringProperty(registration, "client_id");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("base64url");
  const authorizationResponse = await fetch(new URL("/authorize", fixture.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      state,
      resource: fixture.mcpUrl.href,
      owner_token: "test-owner-token-that-is-long-enough",
    }),
  });
  assert.equal(authorizationResponse.status, 302);
  const authorizationLocation = authorizationResponse.headers.get("location");
  assert.ok(authorizationLocation);
  const authorizationResult = new URL(authorizationLocation);
  assert.equal(authorizationResult.searchParams.get("state"), state);
  const code = authorizationResult.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(new URL("/token", fixture.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: fixture.mcpUrl.href,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = jsonObject(await tokenResponse.json());
  assert.equal(tokens.token_type, "bearer");
  return stringProperty(tokens, "access_token");
}

function jsonObject(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function stringProperty(object: Record<string, unknown>, property: string): string {
  const value = object[property];
  assert.equal(typeof value, "string");
  return value as string;
}

async function availablePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await closeHttpServer(server);
  return port;
}

async function listen(running: ReturnType<typeof createServer>, port: number): Promise<HttpServer> {
  const server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
