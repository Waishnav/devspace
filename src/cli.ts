#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { Result as BetterResult } from "better-result";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentCommandError,
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import {
  type OnboardingDestination,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValue,
  setDevspaceConfigValues,
  writeDevspaceAuth,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { readReviewRef } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "config"
  | "agents"
  | "show-changes"
  | "help"
  | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "show-changes":
      await runShowChanges(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "init"
    || command === "doctor"
    || command === "config"
    || command === "agents"
    || command === "show-changes"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.migratedLegacyConfig) {
    console.log(`Migrated legacy configuration to ${files.configPath}`);
  }
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const destinationAnswer = await prompts.multiselect({
      message: "Where will you use DevSpace?",
      options: [
        {
          value: "chatgpt",
          label: "ChatGPT",
          hint: "Connect ChatGPT to projects on this computer.",
        },
        {
          value: "coding-agents",
          label: "Coding Agents",
          hint: "Use DevSpace from Codex, Claude Code, OpenCode, Pi, and similar tools.",
        },
      ],
      initialValues: files.config.server.publicBaseUrl ? ["chatgpt"] : ["coding-agents"],
      required: true,
    });
    if (prompts.isCancel(destinationAnswer)) throw new SetupCancelledError();
    const usage = resolveOnboardingUsage(destinationAnswer as OnboardingDestination[]);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    if (useChatGpt) {
      const defaultRoots = files.config.workspaces.allowedRoots.join(", ") || process.cwd();
      const rootsAnswer = await textPrompt({
        message: `Which project folders can DevSpace access? Press Enter to use ${defaultRoots}`,
        placeholder: defaultRoots,
        defaultValue: defaultRoots,
        validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
      });
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
    }

    const port = files.config.server.port;

    let publicBaseUrl: string | null = null;
    if (useChatGpt) {
      prompts.note(
        [
          `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
          "Paste its public URL below.",
          "",
          "Example: https://your-tunnel-host.example.com",
        ].join("\n"),
        "Connect ChatGPT",
      );
      publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
        message: files.config.server.publicBaseUrl
          ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.server.publicBaseUrl}`
          : "What public URL will ChatGPT connect to?",
        placeholder: files.config.server.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.server.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }));
    }

    const currentSubagents = files.config.subagents;
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      process.env,
      currentSubagents,
    );
    const configuredProviders = currentSubagents.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id);
    const initialValues = configuredProviders.length > 0
      ? configuredProviders
      : availability
          .filter((provider) => provider.available)
          .map((provider) => provider.name);
    const providerAnswer = await prompts.multiselect({
      message: "Which Coding Agents should be available?",
      options: availability.map((provider) => ({
        value: provider.name,
        label: provider.name,
        hint: provider.available
          ? provider.note ?? "available"
          : `unavailable: ${provider.reason ?? "provider preflight failed"}`,
      })),
      initialValues,
      required: true,
    });
    if (prompts.isCancel(providerAnswer)) throw new SetupCancelledError();
    const selectedProviders = providerAnswer as LocalAgentProvider[];
    const subagents = updateOnboardingSubagentsConfig(
      currentSubagents,
      selectedProviders,
    );

    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    setDevspaceConfigValues([
      { path: ["server", "port"], value: port },
      ...(useChatGpt
        ? [{ path: ["server", "publicBaseUrl"], value: publicBaseUrl }]
        : []),
      ...(allowedRoots
        ? [{ path: ["workspaces", "allowedRoots"], value: allowedRoots }]
        : []),
      { path: ["subagents"], value: subagents },
    ]);
    writeDevspaceAuth(auth);

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Coding Agents: ${selectedProviders.join(", ")}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace is ready");
    if (useChatGpt) {
      prompts.note(
        [
          `Owner password: ${auth.ownerToken}`,
          "Use this when ChatGPT asks you to approve DevSpace access.",
        ].join("\n"),
        "Owner password",
      );
    }
    if (useCodingAgents) {
      prompts.note(
        [
          SUBAGENT_SKILL_INSTALL_COMMAND,
          "",
          "The Skills CLI will let you choose which Coding Agents receive it.",
        ].join("\n"),
        "Install the Subagents skill",
      );
    }
    const nextSteps = [
      useChatGpt ? "Run `devspace serve`, then connect ChatGPT." : undefined,
      useCodingAgents ? "Run the skill command above before delegating from your Coding Agents." : undefined,
    ].filter(Boolean).join(" ");
    prompts.outro(nextSteps);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close, localAgentProviders } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because server.allowedHosts contains '*'");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  setDevspaceConfigValue(
    ["server", "publicBaseUrl"],
    normalizeOptionalPublicBaseUrl(value),
  );
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.jsonc and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace show-changes <review-ref> [--json]",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents show <id>",
      "  devspace agents daemon <status|stop|logs>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  devspace config set publicBaseUrl https://example.trycloudflare.com",
      "  devspace serve",
    ].join("\n"),
  );
}

async function runShowChanges(args: string[]): Promise<void> {
  const { args: commandArgs, json } = extractJsonOption(args);
  const [reviewRef, ...extra] = commandArgs;
  if (!reviewRef || extra.length > 0) {
    throw new Error("Usage: devspace show-changes <review-ref> [--json]");
  }

  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const review = await readReviewRef(scope.workspaceRoot, reviewRef);
  if (json) {
    printJson(review);
    return;
  }
  console.log(review.patch || review.result);
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentWorkflowCommand(json, () => runAgentsList(commandArgs, json));
      return;
    case "run":
      await runAgentWorkflowCommand(json, () => runAgentsRun(commandArgs, json));
      return;
    case "continue":
      await runAgentWorkflowCommand(json, () => runAgentsContinue(commandArgs, json));
      return;
    case "show":
      await runAgentWorkflowCommand(json, () => runAgentsShow(commandArgs, json));
      return;
    case "wait":
      await runAgentWorkflowCommand(json, () => runAgentsWait(commandArgs, json));
      return;
    case "targets":
      await runAgentWorkflowCommand(json, () => runAgentsTargets(commandArgs, json));
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      writeAgentWorkflowError(`Unknown agents command: ${subcommand}`, json);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else printAgentXml(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentWorkflowResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }

  printAgentXml(summaries.map(formatAgentSummary).join("\n"));
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target: parsed.target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  const record = presentAgentWorkflowResult(initial, json);
  if (!record) return;

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else printAgentXml(formatAgentObservation(observation));
}

async function runAgentsWait(args: string[], json: boolean): Promise<void> {
  const { ids, timeoutMs } = parseAgentsWaitArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const results = presentAgentWorkflowResult(await client.wait(ids, scope, timeoutMs), json);
  if (!results) return;
  if (json) {
    printJson(results);
    return;
  }
  printAgentXml(results.map(formatAgentObservation).join("\n"));
}

function parseAgentsWaitArgs(args: string[]): { ids: string[]; timeoutMs?: number } {
  const ids: string[] = [];
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--timeout") {
      timeoutMs = parseAgentWaitTimeout(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout=")) {
      timeoutMs = parseAgentWaitTimeout(argument.slice("--timeout=".length));
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}.`);
    ids.push(argument);
  }
  if (ids.length === 0) {
    throw new Error("Usage: devspace agents wait <id>... [--timeout <seconds>] [--json]");
  }
  return { ids, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function parseAgentWaitTimeout(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("Agent wait timeout must be a non-negative integer number of seconds.");
  }
  const timeoutMs = Number(value) * 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error("Agent wait timeout is too large.");
  }
  return timeoutMs;
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: devspace agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function presentAgentWorkflowResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  const error = toAgentErrorPayload(result.error);
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
  return undefined;
}

async function runAgentWorkflowCommand(json: boolean, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    writeAgentWorkflowError(error instanceof Error ? error.message : String(error), json);
  }
}

function writeAgentWorkflowError(message: string, json: boolean): void {
  const error = { code: "AGENT_COMMAND_ERROR", message, retryable: false };
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
}

function printAgentXml(fragment: string): void {
  if (fragment) console.log(fragment);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls [--json]",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents wait <id>... [--timeout <seconds>] [--json]",
      "  devspace agents targets [--json]",
      "  devspace agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
