import { isJsonString } from "./json-value.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";
import type { WorkspaceDescription } from "./workspaces.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const OWNER_TOKEN = "test-owner-token-that-is-long-enough";

test("workspace pages require an owner session", async (t) => {
  const { baseUrl, root } = await startServer(t);
  const sameOrigin = { Origin: baseUrl, "Sec-Fetch-Site": "same-origin" };

  const api = await fetch(`${baseUrl}/web/api/workspaces`);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("access-control-allow-origin"), null);
  const page = await fetch(`${baseUrl}/web/w/ws_web`, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/web/login?next=%2Fweb%2Fw%2Fws_web");

  const wrong = await login(baseUrl, "not-the-owner-token", sameOrigin);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const crossSite = await login(baseUrl, OWNER_TOKEN, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get("set-cookie"), null);

  const legacyCrossSite = await login(baseUrl, OWNER_TOKEN, { Origin: "https://evil.example" });
  assert.equal(legacyCrossSite.status, 403);

  const accepted = await login(baseUrl, OWNER_TOKEN, sameOrigin, "/web/w/ws_web");
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/web/w/ws_web");
  const cookie = accepted.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^devspace_web_session=[\w-]+;/);
  assert.match(cookie, /Path=\/web/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(";")[0]!;

  const listed = await fetch(`${baseUrl}/web/api/workspaces`, { headers: { Cookie: session } });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  // SAFETY: The surrounding checks or construction already match this type.
  const body = await listed.json() as { workspaces: Array<{ workspaceId: string; root: string }> };
  assert.deepEqual(body.workspaces.map((workspace) => workspace.workspaceId), ["ws_web"]);
  assert.equal(body.workspaces[0]?.root, root);

  const forged = await fetch(`${baseUrl}/web/api/workspaces`, { headers: { Cookie: "devspace_web_session=forged" } });
  assert.equal(forged.status, 401);

  const logout = await fetch(`${baseUrl}/web/logout`, {
    method: "POST",
    headers: { ...sameOrigin, Cookie: session },
    redirect: "manual",
  });

  assert.equal(logout.status, 303);
  const afterLogout = await fetch(`${baseUrl}/web/api/workspaces`, { headers: { Cookie: session } });
  assert.equal(afterLogout.status, 401);
});

test("workspace detail API preserves a partial instruction inventory and its warning flag", async (t) => {
  const { baseUrl, root } = await startServer(t);

  for (let index = 0; index < 300; index++) {
    const project = join(root, `project-${index}`);
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "nested instructions\n");
  }

  const accepted = await login(baseUrl, OWNER_TOKEN, { Origin: baseUrl });
  const cookie = (accepted.headers.get("set-cookie") ?? "").split(";")[0]!;
  const response = await fetch(`${baseUrl}/web/api/workspaces/ws_web`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  // SAFETY: This is the workspace detail endpoint's JSON response contract.
  const body = await response.json() as { context: WorkspaceDescription };
  assert.equal(body.context.available, true);

  if (!body.context.available) return;

  assert.equal(body.context.agentsDiscoveryTruncated, true);
  assert.ok(body.context.availableAgentsFiles.length > 0);
  assert.ok(body.context.availableAgentsFiles.length < 300);
});

test("workspace pages reject hosts outside the allowed hosts", async (t) => {
  const { baseUrl } = await startServer(t);

  // fetch cannot override Host, so use a raw request like a DNS-rebinding page would send.
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request(`${baseUrl}/web/login`, { headers: { Host: "attacker.example" } }, resolve).on("error", reject).end();
  });

  response.resume();
  assert.equal(response.statusCode, 403);
});

async function startServer(t: TestContext): Promise<{ baseUrl: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-web-test-"));
  const stateDir = join(root, "state");

  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    storage: { stateDir },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent" },
  }));

  const workspaces = new SqliteWorkspaceStore(stateDir);
  workspaces.createSession({ id: "ws_web", root });
  workspaces.close();

  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && !isJsonString(address));

  return { baseUrl: `http://127.0.0.1:${address.port}`, root };
}

function login(
  baseUrl: string,
  ownerToken: string,
  headers: Record<string, string>,
  next = "/web/",
): Promise<Response> {
  return fetch(`${baseUrl}/web/login`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ owner_token: ownerToken, next }),
    redirect: "manual",
  });
}
