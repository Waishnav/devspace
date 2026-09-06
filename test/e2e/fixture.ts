import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec, repository } from "./package.js";

export type Protocol = "legacy" | "modern";

// Config currently accepts ports 1–65535. Ask the OS for a free port, then
// fail on a bind collision rather than ever attaching to an existing server.
async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function fixture(t: TestContext, packageDirectory: string, mode: "codex" | "claude" = "codex") {
  const root = await mkdtemp(join(tmpdir(), "devspace-e2e-"));
  let logs = "";
  const clients = new Set<Client>();
  let stop: (() => Promise<void>) | undefined;
  // One finalizer owns ordered teardown; retain logs even when the scenario fails.
  t.after(async () => {
    try {
      await Promise.all([...clients].map((client) => client.close()));
    } finally {
      try { await stop?.(); }
      finally {
        try {
          const logDir = join(repository, "test-results", "e2e");
          await mkdir(logDir, { recursive: true });
          const logPath = join(logDir, `${t.name.replace(/[^a-z0-9]+/gi, "-")}.log`);
          await writeFile(logPath, logs);
          t.diagnostic(`Server log: ${logPath}`);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project);
  await mkdir(configDir);
  await writeFile(join(project, "README.md"), "hello\n");
  await writeFile(join(project, "AGENTS.md"), "Keep the project greeting concise.\n");
  await git(project, "init");
  await git(project, "config", "user.email", "devspace@example.com");
  await git(project, "config", "user.name", "DevSpace E2E");
  await git(project, "config", "core.autocrlf", "false");
  await git(project, "config", "commit.gpgsign", "false");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Initial fixture");
  const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
  const ownerToken = randomBytes(24).toString("hex");
  const env = { ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken };
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    server: { host: "127.0.0.1", port: Number(new URL(baseUrl).port), publicBaseUrl: baseUrl },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, "worktrees") },
    storage: { stateDir: join(root, "state") },
    skills: { enabled: false, agentDir: join(root, "agents") },
    subagents: { enabled: false, providers: [] },
    tools: { mode },
  }));
  async function start() {
    const child = spawn(process.execPath, [join(packageDirectory, "bin", "devspace.js"), "serve"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = false;
    let startupError: Error | undefined;
    let announced = false;
    logs += `\nStarting ${packageDirectory} on ${baseUrl}; pid=${child.pid}\n`;
    const done = new Promise<void>((resolve) => {
      child.once("error", (error) => { startupError = error; exited = true; resolve(); });
      child.once("exit", (code, signal) => {
        logs += `\nExited code=${code} signal=${signal}\n`;
        exited = true;
        resolve();
      });
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      logs += String(chunk);
      stdout += String(chunk);
      announced = stdout.includes(`devspace listening on ${baseUrl}/mcp`);
    });
    child.stderr.on("data", (chunk) => { logs += String(chunk); });
    stop = async () => {
      if (exited) return;
      if (process.platform === "win32" && child.pid) {
        // Windows signals force-exit the server without running its shutdown
        // handler. Include its descendants if a process scenario failed.
        try {
          await exec("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000 });
        } catch (error) {
          if (!exited) throw error;
        }
        await done;
        return;
      }
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await done; } finally { clearTimeout(timer); }
    };
    const deadline = Date.now() + 20_000;
    while (!announced) {
      if (exited || Date.now() > deadline) throw new Error(`Packaged server did not start: ${startupError ?? ""}\n${logs}`);
      await delay(25);
    }
    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
  }

  await start();
  const tokens = await authenticate(baseUrl, ownerToken);

  async function connect(accessToken = tokens.access_token) {
    const client = new Client({ name: "devspace-e2e", version: "1.0.0" });
    clients.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }));
    return client;
  }

  async function modern(method: string, params: Record<string, unknown>, token = tokens.access_token) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        "mcp-method": method, "mcp-protocol-version": "2026-07-28",
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomBytes(8).toString("hex"), method,
        params: { ...params, _meta: { ...params._meta as object,
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
  }

  async function session(protocol: Protocol) {
    const client = protocol === "legacy" ? await connect() : undefined;
    return {
      async call(name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {}) {
        if (client) return CallToolResultSchema.parse(await client.callTool({ name, arguments: args, _meta: meta }));
        const response = await modern("tools/call", { name, arguments: args, _meta: meta });
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json() as { result?: unknown; error?: unknown };
        assert.equal(body.error, undefined, JSON.stringify(body));
        return CallToolResultSchema.parse(body.result);
      },
    };
  }

  return { root, project, baseUrl, env, tokens, connect, modern, session,
    async restart() {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      await stop?.();
      await start();
    },
  };
}

export async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 10_000 })).stdout.trim();
}

async function authenticate(baseUrl: string, ownerToken: string) {
  const redirect = "http://127.0.0.1/callback";
  const resource = `${baseUrl}/mcp`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST", signal: AbortSignal.timeout(5_000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "DevSpace E2E", redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id } = await registration.json() as { client_id: string };
  assert.equal(typeof client_id, "string");
  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
    body: new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", scope: "devspace", resource,
      state: "e2e", owner_token: ownerToken }),
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  const exchange = await fetch(`${baseUrl}/token`, {
    method: "POST", signal: AbortSignal.timeout(5_000),
    body: new URLSearchParams({ grant_type: "authorization_code", client_id, code,
      code_verifier: verifier, redirect_uri: redirect, resource }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token: string; refresh_token: string };
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");
  return { ...tokens, client_id };
}
