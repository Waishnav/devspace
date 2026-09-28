import { createHash } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import spawn from "cross-spawn";
import type { ServerConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const EXT_APPS_REPOSITORY = "https://github.com/modelcontextprotocol/ext-apps.git";
const EXT_APPS_COMMIT = "82221c0c8ce7661efa6771c9d461511b1650495f"; // v2.0.3
const DEVSPACE_PORT = 17676;
const AUTH_PROXY_PORT = 17677;
const HOST_PORT = 8080;
const SANDBOX_PORT = 8081;
const OWNER_TOKEN = "browser-qa-owner-token";

const checkoutRoot = resolve(process.cwd());
const qaRoot = join(checkoutRoot, ".devspace-dev", "browser-qa");
const runRoot = join(qaRoot, "run");
const fixtureRoot = join(runRoot, "fixture");
const stateDir = join(runRoot, "state");
const worktreeRoot = join(runRoot, "worktrees");
const extAppsRoot = join(qaRoot, "ext-apps");
const basicHostRoot = join(extAppsRoot, "examples", "basic-host");
const serveOnly = process.argv.includes("--serve");

let devspaceHttpServer: HttpServer | undefined;
let authProxy: HttpServer | undefined;
let hostHttpServer: HttpServer | undefined;
let sandboxHttpServer: HttpServer | undefined;
let closeDevspace: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  await assertCommand("agent-browser", ["doctor"]);
  await assertCommand("ffmpeg", ["-version"]);
  await assertPortsAvailable([DEVSPACE_PORT, AUTH_PROXY_PORT, HOST_PORT, SANDBOX_PORT]);

  await run("pnpm", ["build:app"], { stdio: "inherit" });
  await prepareFixture();
  await prepareBasicHost();

  const running = createServer(browserQaConfig(), { incomingArtifactAdapters: [] });
  closeDevspace = running.close;
  devspaceHttpServer = running.app.listen(DEVSPACE_PORT, "127.0.0.1");
  await onceListening(devspaceHttpServer);

  const accessToken = await issueAccessToken();
  authProxy = createAuthProxy(accessToken);
  authProxy.listen(AUTH_PROXY_PORT, "127.0.0.1");
  await onceListening(authProxy);

  [hostHttpServer, sandboxHttpServer] = await startReferenceHost();
  await waitForUrl(`http://127.0.0.1:${HOST_PORT}/api/servers`);

  console.log(`DevSpace browser QA host: http://127.0.0.1:${HOST_PORT}`);
  console.log(`Fixture project: ${fixtureRoot}`);

  if (serveOnly) {
    console.log("QA host is ready. Press Ctrl-C when finished.");
    await waitForSignal();
  } else {
    const outputDir = await runSmoke();
    console.log(`Browser QA artifacts: ${outputDir}`);
  }
}

function browserQaConfig(): ServerConfig {
  return {
    configDir: join(runRoot, "config"),
    host: "127.0.0.1",
    port: DEVSPACE_PORT,
    oauth: {
      ownerToken: OWNER_TOKEN,
      accessTokenTtlSeconds: 60 * 60,
      refreshTokenTtlSeconds: 60 * 60,
      scopes: ["devspace"],
      allowedResourceUrls: [],
      allowedRedirectHosts: ["127.0.0.1", "localhost"],
    },
    allowedRoots: [checkoutRoot],
    allowedHosts: ["127.0.0.1", "localhost"],
    publicBaseUrl: `http://127.0.0.1:${DEVSPACE_PORT}`,
    toolMode: "codex",
    uiEnabled: true,
    stateDir,
    worktreeRoot,
    artifactsEnabled: false,
    artifactMaxFileBytes: 100 * 1024 * 1024,
    skillsEnabled: false,
    skillPaths: [],
    devspaceSkillsDir: join(runRoot, "skills"),
    devspaceAgentsDir: join(runRoot, "agents"),
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
    agentDir: join(runRoot, "agent"),
    logging: {
      level: "warn",
      format: "pretty",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

async function prepareFixture(): Promise<void> {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(fixtureRoot, "README.md"), "browser qa baseline\n");
  await run("git", ["init", "-q"], { cwd: fixtureRoot });
  await run("git", ["config", "user.email", "devspace@example.com"], { cwd: fixtureRoot });
  await run("git", ["config", "user.name", "DevSpace Browser QA"], { cwd: fixtureRoot });
  await run("git", ["add", "README.md"], { cwd: fixtureRoot });
  await run("git", ["commit", "-qm", "Initial fixture"], { cwd: fixtureRoot });
  await writeFile(join(fixtureRoot, "README.md"), "browser qa baseline\nbrowser qa change\n");
}

async function prepareBasicHost(): Promise<void> {
  let currentCommit = "";
  try {
    currentCommit = (await capture("git", ["-C", extAppsRoot, "rev-parse", "HEAD"])).trim();
  } catch {
    // First run has no cached reference host.
  }

  if (currentCommit !== EXT_APPS_COMMIT) {
    await rm(extAppsRoot, { recursive: true, force: true });
    await mkdir(qaRoot, { recursive: true });
    await run("git", ["init", "-q", extAppsRoot]);
    await run("git", ["-C", extAppsRoot, "remote", "add", "origin", EXT_APPS_REPOSITORY]);
    await run("git", ["-C", extAppsRoot, "fetch", "-q", "--depth", "1", "origin", EXT_APPS_COMMIT]);
    await run("git", ["-C", extAppsRoot, "checkout", "-q", "FETCH_HEAD"]);
  }

  try {
    await access(join(extAppsRoot, "node_modules"));
  } catch {
    await run("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: extAppsRoot,
      stdio: "inherit",
    });
  }
  await run("npm", ["run", "--workspace", "examples/basic-host", "build"], {
    cwd: extAppsRoot,
    stdio: "inherit",
  });
}

async function startReferenceHost(): Promise<[HttpServer, HttpServer]> {
  // Use the official basic-host build, but serve its single-file pages ourselves
  // so QA does not depend on the example's development-server runtime.
  const indexHtml = await readFile(join(basicHostRoot, "dist", "index.html"));
  const sandboxHtml = await readFile(join(basicHostRoot, "dist", "sandbox.html"));

  const host = createHttpServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${HOST_PORT}`);
    if (url.pathname === "/api/servers") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([`http://127.0.0.1:${AUTH_PROXY_PORT}/mcp`]));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(indexHtml);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  const sandbox = createHttpServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${SANDBOX_PORT}`);
    if (url.pathname !== "/" && url.pathname !== "/sandbox.html") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    let csp: BrowserQaCsp | undefined;
    const encodedCsp = url.searchParams.get("csp");
    if (encodedCsp) {
      try {
        csp = JSON.parse(encodedCsp) as BrowserQaCsp;
      } catch {
        // Invalid CSP metadata should fall back to the restrictive defaults.
      }
    }
    res.setHeader("content-security-policy", buildSandboxCsp(csp));
    res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
    res.setHeader("pragma", "no-cache");
    res.setHeader("expires", "0");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(sandboxHtml);
  });

  host.listen(HOST_PORT, "127.0.0.1");
  sandbox.listen(SANDBOX_PORT, "127.0.0.1");
  await Promise.all([onceListening(host), onceListening(sandbox)]);
  return [host, sandbox];
}

interface BrowserQaCsp {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

function buildSandboxCsp(csp?: BrowserQaCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ");
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ].join("; ");
}

function sanitizeCspDomains(domains?: string[]): string[] {
  return (domains ?? []).filter((domain) => typeof domain === "string" && !/[;\r\n'" ]/.test(domain));
}

function createAuthProxy(accessToken: string): HttpServer {
  return createHttpServer((req, res) => {
    if (req.method === "OPTIONS") {
      setCorsHeaders(req.headers.origin, req.headers["access-control-request-headers"] as string | undefined, res.setHeader.bind(res));
      res.writeHead(204);
      res.end();
      return;
    }

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: DEVSPACE_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${DEVSPACE_PORT}`,
        authorization: `Bearer ${accessToken}`,
      },
    }, (upstreamResponse) => {
      const headers = {
        ...upstreamResponse.headers,
        ...corsHeaders(req.headers.origin),
      };
      delete headers["access-control-allow-origin"];
      headers["access-control-allow-origin"] = req.headers.origin ?? `http://127.0.0.1:${HOST_PORT}`;
      res.writeHead(upstreamResponse.statusCode ?? 500, headers);
      upstreamResponse.pipe(res);
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(error));
    });
    req.pipe(upstream);
  });
}

function setCorsHeaders(
  origin: string | undefined,
  requestedHeaders: string | undefined,
  setHeader: (name: string, value: string) => unknown,
): void {
  for (const [name, value] of Object.entries(corsHeaders(origin, requestedHeaders))) {
    setHeader(name, value);
  }
}

function corsHeaders(origin?: string, requestedHeaders?: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? `http://127.0.0.1:${HOST_PORT}`,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": requestedHeaders ?? "content-type, accept, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
    vary: "origin",
  };
}

async function issueAccessToken(): Promise<string> {
  const baseUrl = `http://127.0.0.1:${DEVSPACE_PORT}`;
  const redirectUri = "http://127.0.0.1/callback";
  const resource = `${baseUrl}/mcp`;
  const verifier = "devspace-browser-qa-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace browser QA",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registration.status !== 201) throw new Error(`OAuth registration failed: ${await registration.text()}`);
  const { client_id: clientId } = await registration.json() as { client_id?: string };
  if (!clientId) throw new Error("OAuth registration did not return a client_id");

  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      owner_token: OWNER_TOKEN,
    }),
    redirect: "manual",
  });
  const location = approval.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (approval.status !== 302 || !code) throw new Error(`OAuth approval failed: ${await approval.text()}`);

  const exchange = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  if (!exchange.ok) throw new Error(`OAuth token exchange failed: ${await exchange.text()}`);
  const { access_token: accessToken } = await exchange.json() as { access_token?: string };
  if (!accessToken) throw new Error("OAuth token exchange did not return an access token");
  return accessToken;
}

async function runSmoke(): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outputDir = join(qaRoot, "artifacts", timestamp);
  await mkdir(outputDir, { recursive: true });
  const session = (await capture("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "devspace-browser-qa"])).trim();
  const env = { ...process.env, AGENT_BROWSER_SESSION: session };
  const videoPath = join(outputDir, "smoke.webm");
  let workspaceId: string | undefined;
  let passed = false;
  let failure: unknown;

  try {
    await run("agent-browser", ["open", `http://127.0.0.1:${HOST_PORT}`], { env });
    await run("agent-browser", ["wait", "--load", "domcontentloaded"], { env });
    await run("agent-browser", [
      "wait",
      "--fn",
      "Array.from(document.querySelectorAll('select option')).some((option) => option.textContent === 'open_workspace')",
    ], { env });
    await run("agent-browser", ["screenshot", "--annotate", join(outputDir, "01-host.png")], { env });
    await run("agent-browser", ["record", "start", videoPath, "--cursor", "--contact-sheet"], { env });

    await run("agent-browser", ["find", "label", "Input", "fill", JSON.stringify({ path: fixtureRoot, mode: "checkout" })], { env });
    await run("agent-browser", ["find", "role", "button", "click", "--name", "Call Tool"], { env });
    await run("agent-browser", ["wait", "--fn", "document.querySelectorAll('iframe').length >= 1"], { env });
    await run("agent-browser", ["wait", "--text", "Tool Result"], { env });
    const openWorkspaceSnapshot = await capture("agent-browser", ["snapshot"], { env });
    workspaceId = openWorkspaceSnapshot.match(/ws_[a-f0-9]+/)?.[0];
    if (!workspaceId) throw new Error("open_workspace result did not expose a workspace_id");
    await writeFile(join(outputDir, "open-workspace.txt"), openWorkspaceSnapshot);
    await run("agent-browser", ["screenshot", "--annotate", join(outputDir, "02-open-workspace.png")], { env });

    await run("agent-browser", ["select", "form label:nth-of-type(2) select", "show_changes"], { env });
    await run("agent-browser", ["find", "label", "Input", "fill", JSON.stringify({ workspace_id: workspaceId })], { env });
    await run("agent-browser", ["find", "role", "button", "click", "--name", "Call Tool"], { env });
    await run("agent-browser", ["wait", "--fn", "document.querySelectorAll('iframe').length >= 2"], { env });
    await run("agent-browser", [
      "wait",
      "--fn",
      "(document.body.innerText.match(/Tool Result/g) ?? []).length >= 2",
    ], { env });
    await run("agent-browser", ["screenshot", "--annotate", join(outputDir, "03-show-changes.png")], { env });

    await writeFile(join(outputDir, "snapshot.txt"), await capture("agent-browser", ["snapshot"], { env }));
    await writeFile(join(outputDir, "console.txt"), await capture("agent-browser", ["console"], { env }));
    await writeFile(join(outputDir, "errors.txt"), await capture("agent-browser", ["errors"], { env }));
    passed = true;
  } catch (error) {
    failure = error;
    try {
      await run("agent-browser", ["screenshot", "--annotate", join(outputDir, "failure.png")], { env });
      await writeFile(join(outputDir, "failure-snapshot.txt"), await capture("agent-browser", ["snapshot"], { env }));
      await writeFile(join(outputDir, "failure-console.txt"), await capture("agent-browser", ["console"], { env }));
      await writeFile(join(outputDir, "failure-errors.txt"), await capture("agent-browser", ["errors"], { env }));
    } catch {
      // Preserve the original QA failure.
    }
  } finally {
    try {
      await run("agent-browser", ["record", "stop"], { env });
    } catch {
      // Recording may not have started if setup failed early.
    }
    try {
      await run("agent-browser", ["close"], { env });
    } catch {
      // Session cleanup should not hide the QA result.
    }
  }

  await writeFile(join(outputDir, "report.md"), [
    "# DevSpace browser QA",
    "",
    `- status: ${passed ? "pass" : "fail"}`,
    `- reference host: modelcontextprotocol/ext-apps@${EXT_APPS_COMMIT}`,
    `- fixture: ${fixtureRoot}`,
    `- workspace_id: ${workspaceId ?? "not resolved"}`,
    ...(failure ? ["", "## Failure", "", "```", String(failure), "```"] : []),
    "",
  ].join("\n"));

  if (!passed) throw failure instanceof Error ? failure : new Error(String(failure));
  return outputDir;
}

async function assertCommand(command: string, args: string[]): Promise<void> {
  try {
    await run(command, args, { stdio: "ignore" });
  } catch {
    throw new Error(`${command} is required for browser QA`);
  }
}

async function assertPortsAvailable(ports: number[]): Promise<void> {
  for (const port of ports) {
    await new Promise<void>((resolvePromise, reject) => {
      const probe = createHttpServer();
      probe.once("error", () => reject(new Error(`Port ${port} is already in use; browser QA will not replace its owner.`)));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePromise()));
    });
  }
}

async function waitForUrl(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function onceListening(server: HttpServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("listening", resolvePromise);
    server.once("error", reject);
  });
}

function waitForSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    process.once("SIGINT", resolvePromise);
    process.once("SIGTERM", resolvePromise);
  });
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore" | "inherit";
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? checkoutRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function capture(command: string, args: string[], options: Omit<RunOptions, "stdio"> = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? checkoutRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

async function cleanup(): Promise<void> {
  await Promise.all([
    hostHttpServer ? closeServer(hostHttpServer) : Promise.resolve(),
    sandboxHttpServer ? closeServer(sandboxHttpServer) : Promise.resolve(),
    authProxy ? closeServer(authProxy) : Promise.resolve(),
    devspaceHttpServer ? closeServer(devspaceHttpServer) : Promise.resolve(),
  ]);
  await closeDevspace?.();
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

try {
  await main();
} finally {
  await cleanup();
}
