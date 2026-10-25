import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { build as viteBuild } from "vite";
import {
  listScenarioNames,
  loadScenario,
  resolveTemplates,
  type Scenario,
} from "./scenario.js";
import type { QaCardCall, QaRun, QaStep } from "./transcript.js";

// cross-spawn resolves pnpm and agent-browser shims on Windows.
const spawn = createRequire(import.meta.url)("cross-spawn") as typeof import("node:child_process").spawn;
const harnessRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const qaStateRoot = join(harnessRoot, ".devspace-dev", "qa");
const hostSourceRoot = fileURLToPath(new URL("./host/", import.meta.url));
const WORKSPACE_ID_PATTERN = /\bws_[a-f0-9]{6,}\b/;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: "string" },
    serve: { type: "boolean", default: false },
    "no-browser": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    theme: { type: "string", default: "light" },
    "bare-host": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

const cleanups: Array<() => Promise<void>> = [];

async function main(): Promise<void> {
  if (options.list) {
    for (const name of await listScenarioNames()) {
      const scenario = await loadScenario(name);
      console.log(`${name}\t${scenario.description}`);
    }
    return;
  }

  const checkout = resolve(options.checkout ?? harnessRoot);
  const names = positionals.length > 0 ? positionals : await listScenarioNames();
  const useBrowser = !options["no-browser"];
  if (options.serve && names.length !== 1) {
    throw new Error("--serve keeps one scenario's server and host running; pass exactly one scenario.");
  }
  if (!["light", "dark"].includes(options.theme ?? "")) throw new Error("--theme must be light or dark.");
  if (useBrowser || options.serve) await assertCommand("agent-browser", ["--version"]);

  if (!options["no-build"]) {
    // The source server reads the widget from dist/ui, so the target checkout must be rebuilt.
    await run("pnpm", ["build:app"], { cwd: checkout, stdio: "inherit" });
  }
  // Each batch builds its own host so parallel QA runs never share output.
  const batch = `${timestamp()}-${process.pid}`;
  const hostDistRoot = join(qaStateRoot, "runs", batch, "host");
  await buildHost(hostDistRoot);
  let failed = 0;
  for (const name of names) {
    const scenario = await loadScenario(name);
    const outcome = await runScenario(scenario, {
      checkout,
      runDir: join(qaStateRoot, "runs", batch, scenario.name),
      useBrowser,
      hostDistRoot,
    });
    if (outcome.failures.length > 0) failed += 1;
    console.log(`${outcome.failures.length === 0 ? "PASS" : "FAIL"} ${scenario.name} → ${outcome.reportPath}`);
    for (const failure of outcome.failures) console.log(`  - ${failure}`);

    if (options.serve) {
      console.log(`\nQA host:   ${outcome.hostUrl}`);
      console.log(`Server log: ${outcome.serverLog}`);
      console.log("Keeping the server and host running. Press Ctrl-C to stop.");
      await waitForSignal();
    }
    await runCleanups();
  }
  if (failed > 0) process.exitCode = 1;
}

interface ScenarioOutcome {
  failures: string[];
  reportPath: string;
  hostUrl: string;
  serverLog: string;
}

async function runScenario(
  scenario: Scenario,
  context: { checkout: string; runDir: string; useBrowser: boolean; hostDistRoot: string },
): Promise<ScenarioOutcome> {
  const { checkout, runDir } = context;
  const dirs = {
    home: join(runDir, "home"),
    config: join(runDir, "config"),
    state: join(runDir, "state"),
    worktrees: join(runDir, "worktrees"),
    workspaces: join(runDir, "workspaces"),
    artifacts: join(runDir, "artifacts"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const fixture = join(dirs.workspaces, "fixture");
  await prepareFixture(fixture, scenario, dirs.home);

  const port = await freePort();
  const ownerToken = randomBytes(24).toString("hex");
  await writeFile(join(dirs.config, "config.jsonc"), `${JSON.stringify(deepMerge({
    configVersion: 1,
    server: { host: "127.0.0.1", port },
    workspaces: { allowedRoots: [dirs.workspaces], worktreeRoot: dirs.worktrees },
    storage: { stateDir: dirs.state },
    skills: { agentDir: join(dirs.home, ".codex") },
    logging: { level: "info", format: "json", requests: true, toolCalls: true },
  }, scenario.config ?? {}), null, 2)}\n`);

  const serverLog = join(runDir, "server.log");
  const baseUrl = `http://127.0.0.1:${port}`;
  // HOME isolation keeps the user's global instructions, skills, and agent CLIs out of the run.
  const server = await startServer(checkout, serverLog, {
    ...process.env,
    HOME: dirs.home,
    DEVSPACE_CONFIG_DIR: dirs.config,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    ...scenario.env,
  });
  cleanups.push(() => stopProcess(server));

  const accessToken = await issueAccessToken(baseUrl, ownerToken, scenario.host?.clientName ?? "DevSpace QA");
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (scenario.host?.userAgent) headers["user-agent"] = scenario.host.userAgent;
  const client = new Client({ name: "devspace-qa-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  }));
  cleanups.push(() => client.close());

  const { tools } = await client.listTools();
  const qaRun: QaRun = {
    scenario: { name: scenario.name, description: scenario.description },
    checkout: await checkoutInfo(checkout),
    serverUrl: baseUrl,
    fixture,
    tools,
    steps: [],
    resources: {},
    cardCalls: [],
  };
  await replaySteps(client, scenario, qaRun);

  const transcriptPath = join(runDir, "transcript.json");
  await writeFile(transcriptPath, `${JSON.stringify(qaRun, null, 2)}\n`);

  const host = await startHost(client, qaRun, transcriptPath, context.hostDistRoot);
  const hostUrl = `${host.url}/?theme=${options.theme}${options["bare-host"] ? "&styles=none" : ""}`;

  const failures = qaRun.steps.flatMap((step) => step.failures.map((failure) => `step ${step.index} ${step.tool}: ${failure}`));
  let browser: BrowserEvidence | undefined;
  if (context.useBrowser) {
    browser = await captureBrowserEvidence(hostUrl, qaRun, dirs.artifacts, scenario.name);
    failures.push(...browser.failures);
  }

  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, renderReport(qaRun, { failures, browser, hostUrl, serverLog, transcriptPath }));
  return { failures, reportPath, hostUrl, serverLog };
}

async function replaySteps(client: Client, scenario: Scenario, qaRun: QaRun): Promise<void> {
  const variables: Record<string, string | undefined> = { fixture: qaRun.fixture };
  for (const [index, step] of scenario.steps.entries()) {
    let args: Record<string, unknown>;
    try {
      args = resolveTemplates(step.arguments, variables) as Record<string, unknown>;
    } catch (caught) {
      // Later steps depend on this one, so stop here but keep the evidence gathered so far.
      qaRun.steps.push({
        index,
        label: step.label,
        tool: step.tool,
        arguments: step.arguments,
        durationMs: 0,
        failures: [caught instanceof Error ? caught.message : String(caught)],
      });
      break;
    }
    const startedAt = performance.now();
    const failures: string[] = [];
    let result: CallToolResult | undefined;
    let error: string | undefined;
    try {
      result = await client.callTool({ name: step.tool, arguments: args }) as CallToolResult;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      failures.push(`call failed: ${error}`);
    }
    const durationMs = Math.round(performance.now() - startedAt);

    const text = result ? resultText(result) : "";
    const workspaceId = (result?.structuredContent as { workspace_id?: unknown } | undefined)?.workspace_id;
    variables.workspace_id = typeof workspaceId === "string"
      ? workspaceId
      : text.match(WORKSPACE_ID_PATTERN)?.[0] ?? variables.workspace_id;

    if (result) {
      const expectError = step.expect?.isError ?? false;
      if (Boolean(result.isError) !== expectError) {
        failures.push(expectError ? "expected an error result" : `unexpected error result: ${text.slice(0, 300)}`);
      }
      for (const needle of step.expect?.text ?? []) {
        if (!text.includes(needle)) failures.push(`result text does not contain ${JSON.stringify(needle)}`);
      }
    }

    const resourceUri = uiResourceUri(qaRun.tools.find((tool) => tool.name === step.tool));
    if (resourceUri && !qaRun.resources[resourceUri]) {
      const read = await client.readResource({ uri: resourceUri });
      const content = read.contents[0];
      qaRun.resources[resourceUri] = {
        mimeType: content?.mimeType,
        html: content && "text" in content ? content.text : "",
        meta: (content?._meta ?? {}) as Record<string, unknown>,
      };
    }

    const qaStep: QaStep = {
      index,
      label: step.label,
      tool: step.tool,
      arguments: args,
      result,
      error,
      durationMs,
      resourceUri: result && !result.isError ? resourceUri : undefined,
      failures,
    };
    qaRun.steps.push(qaStep);
  }
}

function uiResourceUri(tool: Tool | undefined): string | undefined {
  const meta = tool?._meta as { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" ? uri : undefined;
}

function resultText(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

async function prepareFixture(fixture: string, scenario: Scenario, home: string): Promise<void> {
  await mkdir(fixture, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = DevSpace QA\n\temail = qa@devspace.invalid\n[init]\n\tdefaultBranch = main\n");
  const gitEnv = { ...process.env, HOME: home };
  for (const [path, content] of Object.entries(scenario.fixture.files)) await writeFixtureFile(fixture, path, content);
  await run("git", ["init", "-q"], { cwd: fixture, env: gitEnv });
  await run("git", ["add", "-A"], { cwd: fixture, env: gitEnv });
  await run("git", ["commit", "-qm", "Initial fixture"], { cwd: fixture, env: gitEnv });
  for (const [path, content] of Object.entries(scenario.fixture.dirty ?? {})) await writeFixtureFile(fixture, path, content);
}

async function writeFixtureFile(root: string, path: string, content: string): Promise<void> {
  const target = resolve(root, path);
  if (!target.startsWith(`${root}/`)) throw new Error(`Fixture path escapes the fixture: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function startServer(checkout: string, logPath: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, [join(checkout, "bin", "devspace.js"), "serve"], {
    cwd: checkout,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Both streams write into one log, so neither may end it; close it when the process exits.
  log.on("error", (error) => console.warn(`Could not write ${logPath}:`, error));
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  child.once("close", () => log.end());
  let output = "";
  const listening = new Promise<void>((resolveListening, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      output += chunk.toString();
      if (output.includes("devspace listening on")) resolveListening();
    });
    child.once("exit", (code, signal) => {
      reject(new Error(`DevSpace exited before listening (code ${code}, signal ${signal}). See ${logPath}`));
    });
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`DevSpace did not start within 60s. See ${logPath}`)), 60_000).unref();
  });
  try {
    await Promise.race([listening, timeout]);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function issueAccessToken(baseUrl: string, ownerToken: string, clientName: string): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = `${baseUrl}/mcp`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
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
      owner_token: ownerToken,
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

async function buildHost(hostDistRoot: string): Promise<void> {
  await viteBuild({
    configFile: false,
    root: hostSourceRoot,
    base: "./",
    logLevel: "warn",
    build: { outDir: hostDistRoot, emptyOutDir: true },
  });
}

/**
 * The host page and the card sandbox run on separate loopback origins, like
 * real MCP Apps hosts. The bearer token stays in this process: cards reach
 * DevSpace only through the same-origin /api/call endpoint.
 */
async function startHost(
  client: Client,
  qaRun: QaRun,
  transcriptPath: string,
  hostDistRoot: string,
): Promise<{ url: string }> {
  const hostPort = await freePort();
  const sandboxPort = await freePort();
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  const sandboxOrigin = `http://127.0.0.1:${sandboxPort}`;
  const indexHtml = await readFile(join(hostDistRoot, "index.html"), "utf8");

  const host = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", hostOrigin);
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(indexHtml);
        return;
      }
      if (url.pathname === "/api/run") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ...qaRun, resources: undefined, sandboxOrigin }));
        return;
      }
      if (url.pathname === "/api/call" && req.method === "POST") {
        // The bridge proxies real tool calls such as exec_command, so only the host page may use it.
        if (req.headers.origin !== hostOrigin || !req.headers["content-type"]?.startsWith("application/json")) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          step: number;
          name: string;
          arguments?: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        };
        const cardCall: QaCardCall = { step: body.step, name: body.name, arguments: body.arguments ?? {} };
        try {
          cardCall.result = await client.callTool({ name: body.name, arguments: body.arguments, _meta: body._meta }) as CallToolResult;
        } catch (error) {
          cardCall.error = error instanceof Error ? error.message : String(error);
        }
        qaRun.cardCalls.push(cardCall);
        await writeFile(transcriptPath, `${JSON.stringify(qaRun, null, 2)}\n`);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(cardCall));
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        const asset = resolve(hostDistRoot, `.${url.pathname}`);
        if (!asset.startsWith(`${hostDistRoot}/`)) throw new Error("Invalid asset path");
        res.setHeader("content-type", asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "application/octet-stream");
        res.end(await readFile(asset));
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  const sandbox = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", sandboxOrigin);
    const resource = url.pathname === "/resource" ? qaRun.resources[url.searchParams.get("uri") ?? ""] : undefined;
    if (!resource) {
      res.writeHead(404).end("Not found");
      return;
    }
    const csp = (resource.meta.ui as { csp?: SandboxCsp } | undefined)?.csp;
    res.setHeader("content-security-policy", sandboxCsp(csp, hostOrigin));
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(resource.html);
  });

  host.listen(hostPort, "127.0.0.1");
  sandbox.listen(sandboxPort, "127.0.0.1");
  await Promise.all([once(host, "listening"), once(sandbox, "listening")]);
  cleanups.push(() => closeHttpServer(host), () => closeHttpServer(sandbox));
  return { url: hostOrigin };
}

interface SandboxCsp {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

// Mirrors the MCP Apps reference host: the card gets only the domains it declares.
function sandboxCsp(csp: SandboxCsp | undefined, hostOrigin: string): string {
  const domains = (list?: string[]) => (list ?? []).filter((domain) => !/[;\r\n'" ]/.test(domain)).join(" ");
  const resources = domains(csp?.resourceDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' blob: data: ${resources}`.trim(),
    `style-src 'unsafe-inline' blob: data: ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: blob: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${domains(csp?.connectDomains)}`.trim() || "connect-src 'none'",
    `worker-src blob: ${resources}`.trim(),
    csp?.frameDomains?.length ? `frame-src ${domains(csp.frameDomains)}` : "frame-src 'none'",
    `frame-ancestors ${hostOrigin}`,
    "object-src 'none'",
    csp?.baseUriDomains?.length ? `base-uri ${domains(csp.baseUriDomains)}` : "base-uri 'none'",
  ].join("; ");
}

interface BrowserEvidence {
  failures: string[];
  screenshots: string[];
  cards: Array<{ step: number; state: string; height: number; error?: string }>;
  consoleLog: string;
  errorsLog: string;
}

async function captureBrowserEvidence(
  hostUrl: string,
  qaRun: QaRun,
  artifacts: string,
  scenarioName: string,
): Promise<BrowserEvidence> {
  const env = { ...process.env, AGENT_BROWSER_SESSION: `devspace-qa-${scenarioName}-${process.pid}` };
  const browser = (...args: string[]) => capture("agent-browser", args, { env });
  const failures: string[] = [];
  const screenshots: string[] = [];
  try {
    await browser("set", "viewport", "1280", "900");
    await browser("open", hostUrl);
    await browser("wait", "--fn", "window.__devspaceQa?.settled === true", "--timeout", "45000");
    const cards = JSON.parse(JSON.parse(await browser("eval", "JSON.stringify(window.__devspaceQa.cards)"))) as BrowserEvidence["cards"];

    const page = join(artifacts, "page.png");
    await browser("screenshot", "--full", page);
    screenshots.push(page);
    for (const step of qaRun.steps.filter((item) => item.resourceUri)) {
      const shot = join(artifacts, `step-${step.index}-${step.tool}.png`);
      const selector = `#step-${step.index} .card-frame`;
      await browser("wait", selector);
      await browser("scrollintoview", selector);
      await browser("screenshot", selector, shot);
      screenshots.push(shot);
    }
    await writeFile(join(artifacts, "snapshot.txt"), await browser("snapshot"));
    const consoleLog = await browser("console");
    await writeFile(join(artifacts, "console.txt"), consoleLog);
    const { data } = JSON.parse(await browser("errors", "--json")) as { data?: { errors?: unknown[] } };
    const pageErrors = data?.errors ?? [];
    const errorsLog = JSON.stringify(pageErrors, null, 2);
    await writeFile(join(artifacts, "errors.json"), `${errorsLog}\n`);

    for (const card of cards) {
      if (card.state !== "ready") failures.push(`card for step ${card.step} is ${card.state}${card.error ? `: ${card.error}` : ""}`);
      else if (card.height < 24) failures.push(`card for step ${card.step} rendered with height ${card.height}px`);
    }
    if (pageErrors.length > 0) failures.push(`browser reported ${pageErrors.length} page error(s) (see errors.json)`);
    return { failures, screenshots, cards, consoleLog, errorsLog };
  } catch (error) {
    failures.push(`browser capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return { failures, screenshots, cards: [], consoleLog: "", errorsLog: "" };
  } finally {
    await browser("close").catch(() => undefined);
  }
}

function renderReport(
  qaRun: QaRun,
  context: {
    failures: string[];
    browser?: BrowserEvidence;
    hostUrl: string;
    serverLog: string;
    transcriptPath: string;
  },
): string {
  const lines = [
    `# QA: ${qaRun.scenario.name} — ${context.failures.length === 0 ? "PASS" : "FAIL"}`,
    "",
    qaRun.scenario.description,
    "",
    `- Checkout: \`${qaRun.checkout.path}\` (${qaRun.checkout.branch ?? "detached"} @ ${qaRun.checkout.commit?.slice(0, 12) ?? "unknown"}${qaRun.checkout.dirty ? ", dirty" : ""})`,
    `- Transcript: \`${context.transcriptPath}\``,
    `- Server log: \`${context.serverLog}\``,
    `- Host page (only while --serve is running): ${context.hostUrl}`,
    "",
    "## Steps",
    "",
    "| # | Tool | Result | ms | Card |",
    "|---|---|---|---|---|",
    ...qaRun.steps.map((step) => {
      const card = context.browser?.cards.find((item) => item.step === step.index);
      const status = step.error ? "call failed" : step.result?.isError ? "error" : "ok";
      return `| ${step.index} | ${step.label ? `${step.tool} (${step.label})` : step.tool} | ${status}${step.failures.length ? " ✗" : ""} | ${step.durationMs} | ${card ? `${card.state}, ${card.height}px` : step.resourceUri ? "not captured" : "—"} |`;
    }),
    "",
  ];
  if (context.failures.length > 0) {
    lines.push("## Failures", "", ...context.failures.map((failure) => `- ${failure}`), "");
  }
  if (context.browser?.screenshots.length) {
    lines.push("## Screenshots", "", ...context.browser.screenshots.map((path) => `- \`${path}\``), "");
  }
  if (qaRun.cardCalls.length > 0) {
    lines.push("## Card-initiated tool calls", "", ...qaRun.cardCalls.map((call) => `- step ${call.step}: ${call.name}${call.error ? ` (failed: ${call.error})` : call.result?.isError ? " (error result)" : ""}`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function checkoutInfo(path: string): Promise<QaRun["checkout"]> {
  const git = (...args: string[]) => capture("git", ["-C", path, ...args]).then((out) => out.trim()).catch(() => undefined);
  const [commit, branch, status] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("symbolic-ref", "--short", "-q", "HEAD"),
    git("status", "--porcelain"),
  ]);
  return { path, commit, branch: branch || undefined, dirty: Boolean(status) };
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port.");
  return address.port;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) {
    await cleanups.pop()?.().catch((error: unknown) => console.warn("QA cleanup failed:", error));
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function assertCommand(command: string, args: string[]): Promise<void> {
  try {
    await capture(command, args);
  } catch {
    throw new Error(`${command} is required for browser QA. Install it and retry.`);
  }
}

function run(command: string, args: string[], spawnOptions: SpawnOptions = {}): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "ignore", ...spawnOptions });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function capture(command: string, args: string[], spawnOptions: SpawnOptions = {}): Promise<string> {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveCapture(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    process.once("SIGINT", () => resolveSignal());
    process.once("SIGTERM", () => resolveSignal());
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runCleanups();
}
