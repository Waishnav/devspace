#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { resolveTunnelMode, startQuickTunnel, type QuickTunnel } from "./cloudflare-tunnel.js";
import { loadConfig } from "./config.js";
import {
  addWorkspace,
  buildConfigShowResult,
  clearDefaultWorkspace,
  listWorkspaces,
  removeWorkspace,
  resetConfigKey,
  setConfigDomain,
  setConfigHost,
  setConfigPort,
  setDefaultWorkspace,
} from "./config-operations.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { createServiceManager } from "./service/manager.js";
import {
  installSkill,
  listInstalledSkills,
  removeInstalledSkill,
  resolveWorkspaceRoot,
  type SkillInstallSource,
  type SkillScope,
} from "./skill-manager.js";

type Command = "serve" | "service-run" | "init" | "doctor" | "config" | "workspace" | "service" | "skills" | "help";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";
const CLI_ENTRYPOINT = fileURLToPath(import.meta.url);

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve(args);
      return;
    case "service-run":
      await serve([]);
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      await runConfigCommand(args);
      return;
    case "workspace":
      await runWorkspaceCommand(args);
      return;
    case "service":
      await runServiceCommand(args);
      return;
    case "skills":
      await runSkillsCommand(args);
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "service-run" || command === "init" || command === "doctor" || command === "config" || command === "workspace" || command === "service" || command === "skills") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
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
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
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

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}${config.server?.mcpPath ?? "/mcp"}`,
      ...(publicBaseUrl ? [`Public MCP URL: ${new URL(config.server?.mcpPath ?? "/mcp", publicBaseUrl).toString()}`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(args: string[] = []): Promise<void> {
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

  const sessionArgs = extractServeArgs(args);
  if (sessionArgs.additionalRoots.length > 0) {
    process.env.DEVSPACE_ALLOWED_ROOTS = mergeAllowedRoots(sessionArgs.additionalRoots);
  }
  if (sessionArgs.workspace) {
    process.env.DEVSPACE_SESSION_WORKSPACE = sessionArgs.workspace;
  }

  let tunnel: QuickTunnel | undefined;
  const configuredTunnel = resolveTunnelMode({
    args,
    env: process.env,
    configuredTunnel: loadDevspaceFiles().config.tunnel,
  });
  if (configuredTunnel === "cloudflare") {
    const files = loadDevspaceFiles();
    const host = process.env.HOST ?? files.config.host ?? "127.0.0.1";
    const port = Number(process.env.PORT ?? files.config.server?.port ?? files.config.port ?? 7676);
    const tunnelHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const localBaseUrl = `http://${tunnelHost}:${port}`;

    tunnel = await startQuickTunnel(localBaseUrl, { quiet: true });
    process.env.DEVSPACE_PUBLIC_BASE_URL = tunnel.publicBaseUrl;
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}${config.mcpPath}`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ") || "(none configured - workspace access will be denied until you add one)"}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    if (tunnel) {
      console.log(`cloudflare tunnel: ${tunnel.publicBaseUrl}`);
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  const shutdown = () => {
    tunnel?.stop();
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
    console.log(`Local MCP URL: http://${config.host}:${config.port}${config.mcpPath}`);
    console.log(`Public MCP URL: ${new URL(config.mcpPath, config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ") || "(none configured)"}`);
    if (config.allowedRoots.length === 0) {
      console.log("Workspace access: blocked until you add a workspace with `devspace workspace add <path>` or set DEVSPACE_ALLOWED_ROOTS.");
    }
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runConfigCommand(args: string[]): Promise<void> {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand === "show") {
    const show = await buildConfigShowResult(CLI_ENTRYPOINT);
    if (args.includes("--json")) {
      console.log(JSON.stringify(show, null, 2));
      return;
    }

    console.log([
      `bind host: ${show.host}`,
      `port: ${show.port}`,
      `MCP path: ${show.mcpPath}`,
      `public URL: ${show.publicUrl}`,
      `workspaces: ${show.workspaces.join(", ") || "(none)"}`,
      `default workspace: ${show.defaultWorkspace ?? "(none)"}`,
      `service installed: ${show.serviceInstalled ? "yes" : "no"}`,
      `service running: ${show.serviceRunning ? "yes" : "no"}`,
      `platform: ${show.platform}`,
      `service manager: ${show.serviceManager}`,
      `access key: ${show.accessKey}`,
    ].join("\n"));
    return;
  }

  if (subcommand === "port") {
    const port = Number(key);
    console.log(await setConfigPort(port, CLI_ENTRYPOINT));
    return;
  }

  if (subcommand === "host") {
    if (!key) throw new Error("Missing host value.");
    console.log(await setConfigHost(key, CLI_ENTRYPOINT));
    return;
  }

  if (subcommand === "domain") {
    const value = [key, ...rest].join(" ").trim();
    if (!value) throw new Error("Missing domain or URL.");
    console.log(await setConfigDomain(value, CLI_ENTRYPOINT));
    return;
  }

  if (subcommand === "key") {
    console.log(await resetConfigKey(CLI_ENTRYPOINT));
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

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
    server: {
      ...(files.config.server ?? {}),
      publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
    },
  });
  console.log(`Updated ${files.configPath}`);
}

async function runWorkspaceCommand(args: string[]): Promise<void> {
  const [subcommand, ...restArgs] = args;
  const flags = restArgs.filter((arg) => arg.startsWith("--"));
  const positional = restArgs.filter((arg) => !arg.startsWith("--"));
  const value = positional[0];
  switch (subcommand) {
    case "add":
      if (!value) throw new Error("Missing workspace path.");
      console.log(await addWorkspace(value, {
        create: flags.includes("--create"),
        makeDefault: flags.includes("--default"),
      }));
      return;
    case "list": {
      const result = listWorkspaces();
      if (flags.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log([
        "Workspaces:",
        ...result.workspaces.map((workspace) => `${workspace}${workspace === result.defaultWorkspace ? " default" : ""}`),
      ].join("\n"));
      return;
    }
    case "remove":
      if (!value) throw new Error("Missing workspace path.");
      console.log(await removeWorkspace(value));
      return;
    case "default":
      if (!value) throw new Error("Missing workspace path.");
      console.log(await setDefaultWorkspace(value));
      return;
    case "clear-default":
      console.log(await clearDefaultWorkspace());
      return;
    default:
      throw new Error(`Unknown workspace command: ${subcommand ?? ""}`);
  }
}

async function runServiceCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const manager = createServiceManager({ config, cliEntrypoint: CLI_ENTRYPOINT });
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "remove":
      console.log((await manager.remove()).message);
      return;
    case "disable":
      console.log((await manager.disable()).message);
      return;
    case "start":
      console.log((await manager.start()).message);
      return;
    case "stop":
      console.log((await manager.stop()).message);
      return;
    case "restart":
      console.log((await manager.restart()).message);
      return;
    case "status": {
      const status = await manager.status();
      console.log([
        `manager: ${status.manager}`,
        `service: ${status.serviceName}`,
        `installed: ${status.installed ? "yes" : "no"}`,
        `enabled: ${status.enabled ? "yes" : "no"}`,
        `running: ${status.running ? "yes" : "no"}`,
        `endpoint: ${status.endpoint ?? "(unknown)"}`,
        `public base URL: ${status.publicBaseUrl ?? "(unknown)"}`,
        `log path: ${status.logPath ?? "(unknown)"}`,
      ].join("\n"));
      return;
    }
    case "logs": {
      const tail = parseTailArgument(rest);
      console.log(await manager.logs(tail === undefined ? undefined : { tail }));
      return;
    }
    case "doctor": {
      const doctor = await manager.doctor();
      console.log([
        `manager: ${doctor.manager}`,
        ...doctor.checks.map((check) => `[${check.level.toUpperCase()}] ${check.message}`),
      ].join("\n"));
      return;
    }
    default:
      throw new Error(`Unknown service command: ${subcommand ?? ""}`);
  }
}

async function runSkillsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const config = loadConfig();

  switch (subcommand) {
    case "install": {
      const { scope, workspace, source } = parseSkillsInstallArgs(rest);
      const workspaceRoot = scope === "workspace"
        ? resolveWorkspaceRoot(config, workspace ?? process.cwd())
        : undefined;
      const installed = await installSkill({
        config,
        workspaceRoot,
        scope,
        source,
      });
      console.log([
        `Installed ${installed.name}`,
        `Scope: ${installed.scope}`,
        `Path: ${installed.path}`,
        `Source: ${installed.sourceSummary}`,
      ].join("\n"));
      return;
    }
    case "list": {
      const { scope, workspace } = parseSkillsScopeArgs(rest);
      const workspaceRoot = scope === "workspace"
        ? resolveWorkspaceRoot(config, workspace ?? process.cwd())
        : undefined;
      const skills = await listInstalledSkills({
        config,
        workspaceRoot,
        scope,
      });
      if (skills.length === 0) {
        console.log("No installed skills.");
        return;
      }
      console.log(
        skills
          .map((skill) => [
            `${skill.name} (${skill.scope})`,
            `  path: ${skill.path}`,
            `  description: ${skill.description}`,
          ].join("\n"))
          .join("\n"),
      );
      return;
    }
    case "remove": {
      const { scope, workspace, name } = parseSkillsRemoveArgs(rest);
      const workspaceRoot = scope === "workspace"
        ? resolveWorkspaceRoot(config, workspace ?? process.cwd())
        : undefined;
      const removed = await removeInstalledSkill({
        config,
        workspaceRoot,
        scope,
        name,
      });
      console.log([
        `Removed ${removed.name}`,
        `Scope: ${removed.scope}`,
        `Path: ${removed.removedPath}`,
      ].join("\n"));
      return;
    }
    default:
      throw new Error(`Unknown skills command: ${subcommand ?? ""}`);
  }
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace serve --add-dir <path>   Temporarily allow an extra workspace root",
      "  devspace serve --workspace <path> Temporarily set the default workspace for this run",
      "  devspace service-run     Internal service entrypoint",
      "  devspace serve --tunnel  Start the server with an explicit Cloudflare quick tunnel",
      "  devspace serve --no-tunnel  Disable a configured Cloudflare quick tunnel for this run",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config show     Print effective config and service state",
      "  devspace config port <port>",
      "  devspace config host <host>",
      "  devspace config domain <domain-or-url>",
      "  devspace config key",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace workspace add <path> [--default] [--create]",
      "  devspace workspace list [--json]",
      "  devspace workspace remove <path>",
      "  devspace workspace default <path>",
      "  devspace workspace clear-default",
      "  devspace skills install [--workspace <path>] [--repo <owner/repo> --path <skill-dir> [--ref <ref>] | --github-url <url> | --local-path <path>]",
      "  devspace skills install -g [--repo <owner/repo> --path <skill-dir> [--ref <ref>] | --github-url <url> | --local-path <path>]",
      "  devspace skills list [--workspace <path>]",
      "  devspace skills list -g",
      "  devspace skills remove [--workspace <path>] <skill-name>",
      "  devspace skills remove -g <skill-name>",
      "    install expects the target path to point at one standard skill directory with a SKILL.md file",
      "    plugin roots, command folders, and agent-rules directories are rejected",
      "  devspace service start",
      "  devspace service remove",
      "  devspace service disable",
      "  devspace service stop",
      "  devspace service restart",
      "  devspace service status",
      "  devspace service logs [--tail N]",
      "  devspace service doctor",
      "",
      "Optional Cloudflare quick tunnel:",
      "  DEVSPACE_TUNNEL=cloudflare devspace serve",
      "  or set { \"tunnel\": \"cloudflare\" } in ~/.devspace/config.json",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

function parseTailArgument(args: string[]): number | undefined {
  const index = args.indexOf("--tail");
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function extractServeArgs(args: string[]): { additionalRoots: string[]; workspace?: string } {
  const additionalRoots: string[] = [];
  let workspace: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--add-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing path after --add-dir.");
      additionalRoots.push(resolve(expandHomePath(value)));
      index += 1;
      continue;
    }
    if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing path after --workspace.");
      workspace = resolve(expandHomePath(value));
      index += 1;
    }
  }

  return { additionalRoots, workspace };
}

function mergeAllowedRoots(additionalRoots: string[]): string {
  const files = loadDevspaceFiles();
  const merged = new Set([
    ...(files.config.workspaces?.allowed ?? files.config.allowedRoots ?? []),
    ...additionalRoots,
  ]);
  return Array.from(merged).join(",");
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

function parseSkillsInstallArgs(args: string[]): {
  scope: SkillScope;
  workspace?: string;
  source: SkillInstallSource;
} {
  const { scope, workspace } = parseSkillsScopeArgs(args);
  const repo = valueAfterFlag(args, "--repo");
  const path = valueAfterFlag(args, "--path");
  const ref = valueAfterFlag(args, "--ref");
  const githubUrl = valueAfterFlag(args, "--github-url");
  const localPath = valueAfterFlag(args, "--local-path");
  const selectedSources = [Boolean(repo || path), Boolean(githubUrl), Boolean(localPath)].filter(Boolean).length;

  if (selectedSources !== 1) {
    throw new Error("Choose exactly one skill source: --repo/--path, --github-url, or --local-path.");
  }

  if (githubUrl) {
    return {
      scope,
      workspace,
      source: { kind: "github_url", url: githubUrl },
    };
  }

  if (localPath) {
    return {
      scope,
      workspace,
      source: { kind: "local", path: resolve(expandHomePath(localPath)) },
    };
  }

  if (!repo || !path) {
    throw new Error("GitHub install requires both --repo and --path.");
  }

  return {
    scope,
    workspace,
    source: { kind: "github", repo, path, ref: ref || undefined },
  };
}

function parseSkillsRemoveArgs(args: string[]): {
  scope: SkillScope;
  workspace?: string;
  name: string;
} {
  const { scope, workspace } = parseSkillsScopeArgs(args);
  const positional = positionalSkillArgs(args);
  const [name] = positional;
  if (!name) throw new Error("Missing skill name.");
  if (positional.length > 1) throw new Error("Remove accepts exactly one skill name.");
  return { scope, workspace, name };
}

function parseSkillsScopeArgs(args: string[]): {
  scope: SkillScope;
  workspace?: string;
} {
  const global = args.includes("-g") || args.includes("--global");
  const workspace = valueAfterFlag(args, "--workspace");
  if (global && workspace) {
    throw new Error("Use either -g/--global or --workspace, not both.");
  }

  return {
    scope: global ? "global" : "workspace",
    workspace: workspace ? resolve(expandHomePath(workspace)) : undefined,
  };
}

function positionalSkillArgs(args: string[]): string[] {
  return args.filter((arg, index) => !isSkillFlagArgument(args, index));
}

function isSkillFlagArgument(args: string[], index: number): boolean {
  const arg = args[index];
  if (arg === "-g" || arg === "--global") return true;

  const valueFlags = new Set(["--workspace", "--repo", "--path", "--ref", "--github-url", "--local-path"]);
  if (valueFlags.has(arg)) return true;

  const previous = args[index - 1];
  return valueFlags.has(previous);
}

function valueAfterFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value after ${flag}.`);
  }
  return value;
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

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
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
