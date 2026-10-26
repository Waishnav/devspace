import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createLocalAgentDrivers } from "../../src/local-agent-adapters.js";
import { removeDevspaceNodeModulesBinFromPath } from "../../src/local-agent-path.js";
import { PROVIDERS, providerDefinition, type ProviderDefinition } from "./providers.js";

/**
 * Provider conformance suite. Every scenario runs the built `devspace agents`
 * CLI against an isolated config, state directory, and Git fixture, so the
 * path under test is CLI -> daemon -> driver -> provider process. In replay
 * mode the provider process is the shim serving a recorded transcript.
 *
 *   pnpm qa:agents [provider...] [--live | --record] [--scenario <name>]...
 */
type Mode = "replay" | "live" | "record";

interface Run {
  provider: ProviderDefinition;
  mode: Mode;
  scenario: string;
  workspace: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

interface Scenario {
  name: string;
  description: string;
  /** Scenarios that never reach a provider process need no transcript. */
  transcript: boolean;
  run(run: Run): Promise<void>;
}

const harnessDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(harnessDir, "../..");
const cliPath = join(repoRoot, "dist", "cli.js");
const shimPath = join(harnessDir, "shim.ts");
const transcriptsDir = join(harnessDir, "transcripts");
const TURN_TIMEOUT_SECONDS = 180;
const STOP_BOUND_MS = 15_000;

const SCENARIOS: Scenario[] = [
  {
    name: "run-wait",
    description: "C1: run + wait completes with the requested token",
    transcript: true,
    async run(run) {
      const id = await start(run, "Reply with exactly the token PAPAYA-7 and nothing else. Do not use any tools.");
      const result = await waitFor(run, id);
      expect(result.status === "completed", `expected completed, got ${describe(result)}`);
      expect(String(result.response).includes("PAPAYA-7"), `response lacks PAPAYA-7: ${result.response}`);
    },
  },
  {
    name: "continue",
    description: "C2: continue recalls a fact from the first turn",
    transcript: true,
    async run(run) {
      const id = await start(run, "For this conversation, our project codename is BLUEBIRD-4417. Reply with only OK. Do not use any tools.");
      expect((await waitFor(run, id)).status === "completed", "first turn did not complete");
      const continued = await cli(run, ["agents", "continue", id, "--json", "What is our project codename? Reply with only the codename. Do not use any tools."]);
      expect(continued.code === 0, `continue failed: ${continued.stdout}${continued.stderr}`);
      const result = await waitFor(run, id);
      expect(result.status === "completed", `expected completed, got ${describe(result)}`);
      expect(String(result.response).includes("4417"), `response lacks 4417: ${result.response}`);
    },
  },
  {
    name: "read-only",
    description: "C3: a read_only agent asked to create a file completes without creating it",
    transcript: true,
    async run(run) {
      // `agents run` always uses the default write mode; read_only reaches drivers through
      // workflows and the daemon protocol, so this scenario starts the agent through the client.
      const id = await startReadOnly(run, "Create a file named probe.txt containing the word hello using your file tools. Then reply DONE.");
      const result = await waitFor(run, id);
      expect(result.status === "completed", `expected completed, got ${describe(result)}`);
      expect(!existsSync(join(run.workspace, "probe.txt")), "probe.txt was created by a read_only agent");
    },
  },
  {
    name: "stop",
    description: "C4: stop during a long tool call ends the turn as stopped, with no later writes",
    transcript: true,
    async run(run) {
      const id = await start(run, "Run the shell command `sleep 20 && echo late > late.txt`, then reply SLEPT.");
      await waitForEvent(run, id, (event) => event.type === "tool_started");
      const stoppedAt = Date.now();
      const stopped = await cli(run, ["agents", "stop", id, "--json"]);
      expect(stopped.code === 0, `stop failed: ${stopped.stdout}${stopped.stderr}`);
      let result = stopped.json;
      while (result.status === "running" && Date.now() - stoppedAt < STOP_BOUND_MS) {
        await delay(250);
        result = (await cli(run, ["agents", "show", id, "--json"])).json;
      }
      expect(result.status === "stopped", `expected stopped within ${STOP_BOUND_MS}ms, got ${describe(result)}`);
      const before = (await cli(run, ["agents", "events", id, "--json"])).json.events.length;
      await delay(2_000);
      const after = await cli(run, ["agents", "show", id, "--json"]);
      const events = (await cli(run, ["agents", "events", id, "--json"])).json.events;
      expect(after.json.status === "stopped", `status changed after stop: ${describe(after.json)}`);
      expect(events.length === before, "events were appended after the turn stopped");
      expect(!existsSync(join(run.workspace, "late.txt")), "the stopped turn kept writing");
    },
  },
  {
    name: "events",
    description: "C5: events report one turn with messages and, for streaming drivers, tool activity",
    transcript: true,
    async run(run) {
      const id = await start(run, "Use your file reading tool to read README.md, then reply with only the first word of that file.");
      const result = await waitFor(run, id);
      expect(result.status === "completed", `expected completed, got ${describe(result)}`);
      expect(String(result.response).includes("MARIGOLD"), `response lacks MARIGOLD: ${result.response}`);
      const page = (await cli(run, ["agents", "events", id, "--json"])).json;
      const events: Array<{ type: string; turnId: string; status?: string }> = page.events;
      const types = events.map((event) => event.type);
      expect(types[0] === "turn_started", `first event is ${types[0]}`);
      expect(types.at(-1) === "turn_completed" && events.at(-1)?.status === "completed", `last event is ${JSON.stringify(events.at(-1))}`);
      expect(types.includes("message"), `no message event in ${types.join(",")}`);
      expect(events.every((event) => event.turnId === result.turnId), "events span more than one turnId");
      if (streams(run.provider)) {
        expect(types.includes("tool_started") && types.includes("tool_completed"), `no tool events in ${types.join(",")}`);
      }
    },
  },
  {
    name: "missing-command",
    description: "C6: a missing provider command fails with PROVIDER_UNAVAILABLE and a non-zero exit",
    transcript: false,
    async run(run) {
      const result = await cli(run, ["agents", "run", run.provider.id, "--json", "hello"]);
      expect(result.code !== 0, "run exited 0 with a missing provider command");
      expect(result.json?.error?.code === "PROVIDER_UNAVAILABLE", `expected PROVIDER_UNAVAILABLE, got ${result.stdout}`);
    },
  },
];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      live: { type: "boolean", default: false },
      record: { type: "boolean", default: false },
      scenario: { type: "string", multiple: true },
    },
  });
  if (values.live && values.record) throw new Error("--live and --record are exclusive.");
  const mode: Mode = values.record ? "record" : values.live ? "live" : "replay";
  if (!existsSync(cliPath)) throw new Error("dist/cli.js is missing; run pnpm build first.");
  const providers = (positionals.length > 0 ? positionals : recordedProviders()).map(providerDefinition);
  const scenarios = values.scenario
    ? values.scenario.map((name) => SCENARIOS.find((scenario) => scenario.name === name) ?? fail(`Unknown scenario ${name}.`))
    : SCENARIOS;

  const results: Array<{ provider: string; scenario: string; error?: string; ms: number }> = [];
  for (const provider of providers) {
    for (const scenario of scenarios) {
      const startedAt = Date.now();
      const error = await runScenario(provider, scenario, mode).then(() => undefined, (cause: unknown) => (
        cause instanceof Error ? cause.message : String(cause)
      ));
      results.push({ provider: provider.id, scenario: scenario.name, error, ms: Date.now() - startedAt });
      console.log(`${error ? "FAIL" : "PASS"} ${mode} ${provider.id} ${scenario.name} (${Date.now() - startedAt}ms)`);
      if (error) console.log(indent(error));
    }
  }
  const failed = results.filter((result) => result.error);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

async function runScenario(provider: ProviderDefinition, scenario: Scenario, mode: Mode): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "devspace-agents-qa-")));
  const workspace = join(root, "repo");
  const configDir = join(root, "config");
  const runDir = join(root, "run");
  mkdirSync(workspace);
  mkdirSync(runDir);
  git(workspace, ["init", "-q", "-b", "main"]);
  writeFileSync(join(workspace, "README.md"), "MARIGOLD conformance fixture.\n");
  git(workspace, ["add", "."]);
  git(workspace, ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-q", "-m", "fixture"]);

  const command = scenario.name === "missing-command"
    ? join(root, "missing", provider.id)
    : mode === "live"
      ? undefined
      : writeShimWrapper(root, provider, scenario, mode, workspace, runDir);
  mkdirSync(configDir);
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    workspaces: { allowedRoots: [root] },
    storage: { stateDir: join(root, "state") },
    subagents: {
      enabled: true,
      providers: [{
        id: provider.id,
        enabled: true,
        ...(provider.model ? { model: provider.model } : {}),
        ...(command ? { command } : {}),
        ...(mode !== "replay" && provider.liveEnv ? { env: provider.liveEnv() } : {}),
      }],
    },
  }, null, 2));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "agents-qa-owner-token-that-is-long-enough",
    DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "60000",
  };
  // Run as an installed devspace would: this checkout's node_modules/.bin (with the bundled
  // Pi SDK) must not shadow the provider executables on PATH.
  if (env.PATH) env.PATH = removeDevspaceNodeModulesBinFromPath(env.PATH);
  delete env.DEVSPACE_WORKSPACE_ID;
  delete env.DEVSPACE_WORKSPACE_ROOT;
  const run: Run = { provider, mode, scenario: scenario.name, workspace, runDir, env };
  try {
    if (mode === "replay" && scenario.transcript && !existsSync(transcriptPath(provider, scenario) + ".jsonl")) {
      throw new Error(`No transcript; record it with: pnpm qa:agents ${provider.id} --record --scenario ${scenario.name}`);
    }
    await scenario.run(run);
  } catch (error) {
    const report = join(runDir, "replay-failures.log");
    const detail = existsSync(report) ? `\n${readFileSync(report, "utf8").trim()}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}\nstate kept at ${root}`);
  } finally {
    await cli(run, ["agents", "daemon", "stop"]).catch(() => undefined);
  }
  if (!process.env.DEVSPACE_QA_KEEP) rmSync(root, { recursive: true, force: true });
}

/** Provider commands take no arguments, so a small wrapper selects the shim's mode and transcript. */
function writeShimWrapper(
  root: string,
  provider: ProviderDefinition,
  scenario: Scenario,
  mode: Mode,
  workspace: string,
  runDir: string,
): string {
  const variables = {
    DEVSPACE_AGENT_SHIM_MODE: mode,
    DEVSPACE_AGENT_SHIM_PROVIDER: provider.id,
    DEVSPACE_AGENT_SHIM_SCENARIO: scenario.name,
    DEVSPACE_AGENT_SHIM_TRANSCRIPT: transcriptPath(provider, scenario),
    DEVSPACE_AGENT_SHIM_RUN_DIR: runDir,
    DEVSPACE_AGENT_SHIM_WORKSPACE: workspace,
    ...(process.env.DEVSPACE_AGENT_SHIM_TRACE ? { DEVSPACE_AGENT_SHIM_TRACE: "1" } : {}),
  };
  const tsx = import.meta.resolve("tsx");
  const lines = [
    "#!/bin/sh",
    ...Object.entries(variables).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `exec ${shellQuote(process.execPath)} --import ${shellQuote(tsx)} ${shellQuote(shimPath)} "$@"`,
    "",
  ];
  const path = join(root, "bin", `${provider.id}-shim`);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
  return path;
}

async function start(run: Run, prompt: string): Promise<string> {
  const result = await cli(run, ["agents", "run", run.provider.id, "--json", prompt]);
  expect(result.code === 0 && typeof result.json?.id === "string", `run failed: ${result.stdout}${result.stderr}`);
  return result.json.id;
}

async function startReadOnly(run: Run, prompt: string): Promise<string> {
  // A child process, so the client and the daemon it may spawn see only this scenario's env.
  const script = `
    const { loadConfig } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "config.js")).href)});
    const { createLocalAgentClient } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "local-agent-client.js")).href)});
    const result = await createLocalAgentClient(loadConfig()).start(JSON.parse(process.argv[2]));
    console.log(JSON.stringify(result.isOk() ? { id: result.value.id } : { error: result.error }));
  `;
  const input = { target: run.provider.id, prompt, workspaceRoot: run.workspace, writeMode: "read_only" };
  // A file rather than `-e`: the client re-spawns the daemon with this process's execArgv.
  const scriptPath = join(run.runDir, "start-read-only.mjs");
  writeFileSync(scriptPath, script);
  const result = await exec(run, [scriptPath, JSON.stringify(input)]);
  expect(typeof result.json?.id === "string", `read_only start failed: ${result.stdout}${result.stderr}`);
  return result.json.id;
}

async function waitFor(run: Run, id: string): Promise<any> {
  const result = await cli(run, ["agents", "wait", id, "--timeout", String(TURN_TIMEOUT_SECONDS), "--json"]);
  expect(Array.isArray(result.json), `wait failed: ${result.stdout}${result.stderr}`);
  return result.json[0];
}

async function waitForEvent(run: Run, id: string, predicate: (event: any) => boolean): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_SECONDS * 1_000;
  while (Date.now() < deadline) {
    const page = (await cli(run, ["agents", "events", id, "--json"])).json;
    if (page?.events?.some(predicate)) return;
    if (page?.status && page.status !== "running") throw new Error(`turn ended before the expected event: ${JSON.stringify(page)}`);
    await delay(250);
  }
  throw new Error("timed out waiting for an agent event");
}

function cli(run: Run, args: string[]): Promise<CliResult> {
  return exec(run, [cliPath, ...args]);
}

function exec(run: Run, args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: run.workspace, env: run.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      } catch {
        json = undefined;
      }
      resolvePromise({ code, stdout, stderr, json });
    });
  });
}

function streams(provider: ProviderDefinition): boolean {
  const driver = createLocalAgentDrivers().find((entry) => entry.providerInstanceId === provider.id);
  return driver?.capabilities.turns.streaming === true;
}

function recordedProviders(): string[] {
  return Object.keys(PROVIDERS).filter((id) => existsSync(join(transcriptsDir, id)));
}

function transcriptPath(provider: ProviderDefinition, scenario: Scenario): string {
  return join(transcriptsDir, provider.id, scenario.name);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describe(result: any): string {
  return JSON.stringify(result);
}

function fail(message: string): never {
  throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

await main();
