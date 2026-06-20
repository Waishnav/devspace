#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { startQuickTunnel, type QuickTunnel } from "./cloudflare-tunnel.js";

type Command = "serve" | "init" | "doctor" | "config" | "help";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

const useColor = Boolean(output.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (value: string) =>
  useColor ? `\x1b[${code}m${value}\x1b[0m` : String(value);
const c = {
  bold: paint("1"),
  dim: paint("2"),
  cyan: paint("36"),
  green: paint("32"),
  yellow: paint("33"),
  magenta: paint("35"),
};

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve(args);
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
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config") return command;
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

    const defaultTunnel =
      files.config.tunnel === "cloudflare" || !files.config.publicBaseUrl ? "cloudflare" : "manual";
    const tunnelChoice = await selectPrompt<"cloudflare" | "manual">({
      message: "How should ChatGPT or Claude reach this MCP server?",
      initialValue: defaultTunnel,
      options: [
        {
          value: "cloudflare",
          label: "Automatic Cloudflare quick tunnel (recommended)",
          hint: "devspace launches cloudflared and gets a fresh https URL each run",
        },
        {
          value: "manual",
          label: "Manual public URL",
          hint: "paste a URL from your own tunnel or reverse proxy",
        },
      ],
    });

    let tunnel: DevspaceUserConfig["tunnel"];
    let publicBaseUrl: string | null = null;
    if (tunnelChoice === "cloudflare") {
      tunnel = "cloudflare";
      prompts.note(
        [
          "DevSpace will install cloudflared (if needed) and open a Cloudflare",
          "quick tunnel automatically every time you run `devspace serve`.",
          "A new https://<random>.trycloudflare.com URL is minted on each run.",
          "",
          "Override per run with: devspace serve --no-tunnel",
        ].join("\n"),
        "Automatic Cloudflare tunnel",
      );
    } else {
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
      publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
        message: files.config.publicBaseUrl
          ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
          : "What is the public base URL?",
        placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }));
    }

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
      ...(tunnel ? { tunnel } : {}),
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
      ...(tunnel === "cloudflare"
        ? ["Public MCP URL: printed by `devspace serve` once the Cloudflare tunnel opens"]
        : []),
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
    prompts.outro(
      tunnel === "cloudflare"
        ? "Run `devspace serve` to start the server and open the Cloudflare tunnel. It keeps running in the foreground (Ctrl+C to stop) — use a new terminal tab to do other work."
        : "Run `devspace serve` to start the MCP server. It keeps running in the foreground (Ctrl+C to stop).",
    );
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

  prompts.intro(c.bold(c.magenta("DevSpace")));

  let tunnel: QuickTunnel | null = null;
  if (shouldUseCloudflareTunnel(args)) {
    const files = loadDevspaceFiles();
    const host = process.env.HOST ?? files.config.host ?? "127.0.0.1";
    const port = Number(process.env.PORT ?? files.config.port ?? 7676);
    const tunnelHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const localBaseUrl = `http://${tunnelHost}:${port}`;
    const spin = prompts.spinner();
    spin.start("Opening Cloudflare quick tunnel");
    try {
      tunnel = await startQuickTunnel(localBaseUrl, { quiet: true });
      // Make loadConfig() pick up the freshly minted public URL so the tunnel
      // hostname is also added to the Host header allowlist.
      process.env.DEVSPACE_PUBLIC_BASE_URL = tunnel.publicBaseUrl;
      spin.stop(`Cloudflare tunnel ready  ${c.cyan(tunnel.publicBaseUrl)}`);
    } catch (error) {
      spin.stop("Cloudflare tunnel failed to start");
      prompts.log.warn(
        `${error instanceof Error ? error.message : String(error)}\nFalling back to the configured public base URL.`,
      );
    }
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    const localUrl = `http://${config.host}:${config.port}/mcp`;
    const publicUrl = `${config.publicBaseUrl}/mcp`;
    const label = (text: string) => c.dim(text.padEnd(7));
    const noteLines = [
      `${label("Local")} ${localUrl}`,
      `${label("Public")} ${c.cyan(publicUrl)}`,
      `${label("Roots")} ${config.allowedRoots.join(", ")}`,
      `${label("Hosts")} ${config.allowedHosts.join(", ")}`,
      `${label("Auth")} Owner password approval required`,
      `${label("Logs")} ${config.logging.level} ${config.logging.format}`,
    ];
    prompts.note(
      noteLines.join("\n"),
      c.green(tunnel ? "Server running (Cloudflare tunnel live)" : "Server running"),
    );
    if (config.allowedHosts.includes("*")) {
      prompts.log.warn("Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    prompts.outro(
      c.dim(
        "Press Ctrl+C to stop. Keep this terminal open while you use DevSpace — open a new tab for other work.",
      ),
    );
  });

  const shutdown = () => {
    tunnel?.stop();
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => tunnel?.stop());
}

function shouldUseCloudflareTunnel(args: string[] = []): boolean {
  if (args.includes("--no-tunnel")) return false;
  if (args.includes("--tunnel") || args.includes("--tunnel=cloudflare")) return true;

  const envTunnel = process.env.DEVSPACE_TUNNEL?.trim().toLowerCase();
  if (envTunnel === "cloudflare" || envTunnel === "quick") return true;
  if (envTunnel === "none" || envTunnel === "off") return false;

  const files = loadDevspaceFiles();
  const configured = String(files.config.tunnel ?? "").trim().toLowerCase();
  return configured === "cloudflare" || configured === "quick";
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

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
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
      "  devspace serve --tunnel  Start the server with an automatic Cloudflare quick tunnel",
      "  devspace serve --no-tunnel  Start the server without the configured tunnel",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "",
      "Automatic Cloudflare quick tunnel:",
      "  Choose it during `devspace init`, or force it per run:",
      "  DEVSPACE_TUNNEL=cloudflare devspace serve   (or: devspace serve --tunnel)",
      "  cloudflared is auto-installed to ~/.devspace/bin when missing.",
      "",
      "For a fixed temporary tunnel URL:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
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

async function selectPrompt<T>(options: Parameters<typeof prompts.select<T>>[0]): Promise<T> {
  const result = await prompts.select<T>(options);
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  return result as T;
}

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
