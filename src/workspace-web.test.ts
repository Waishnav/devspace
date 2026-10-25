import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
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
  assert.ok(address && typeof address !== "string");
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
