import { createServer } from "./server.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { devspaceAuthPath, loadDevspaceFiles, type DevspaceAuthConfig, type DevspaceUserConfig, writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";
import { createServiceManager, restartServiceIfRunning } from "./service/manager.js";
import { expandHomePath } from "./roots.js";
import { generateOwnerToken } from "./user-config.js";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import type { ServiceManager } from "./service/types.js";

interface ConfigOperationOptions {
  manager?: ServiceManager;
}

export interface ConfigShowResult {
  host: string;
  port: number;
  mcpPath: string;
  publicUrl: string;
  workspaces: string[];
  defaultWorkspace?: string;
  platform: string;
  serviceManager: string;
  serviceInstalled: boolean;
  serviceRunning: boolean;
  accessKey: string;
}

export async function buildConfigShowResult(
  cliEntrypoint: string,
  options: ConfigOperationOptions = {},
): Promise<ConfigShowResult> {
  const config = loadConfig();
  const manager = options.manager ?? createServiceManager({ config, cliEntrypoint });
  const status = await manager.status();
  return {
    host: config.host,
    port: config.port,
    mcpPath: config.mcpPath,
    publicUrl: new URL(config.mcpPath, config.publicBaseUrl).toString(),
    workspaces: config.configuredWorkspaces,
    defaultWorkspace: config.defaultWorkspace,
    platform: process.platform,
    serviceManager: manager.kind,
    serviceInstalled: status.installed,
    serviceRunning: status.running,
    accessKey: maskSecret(effectiveOwnerToken()),
  };
}

export async function setConfigPort(
  port: number,
  cliEntrypoint: string,
  options: ConfigOperationOptions = {},
): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }

  const occupied = await inspectPort(port);
  if (occupied) {
    throw new Error(`Port ${port} is already in use${occupied}.`);
  }

  const files = loadDevspaceFiles();
  writeDevspaceConfig({
    ...files.config,
    host: files.config.server?.host ?? files.config.host ?? "127.0.0.1",
    port,
    server: {
      ...(files.config.server ?? {}),
      host: files.config.server?.host ?? files.config.host ?? "127.0.0.1",
      port,
    },
  });

  return applyConfigUpdate(cliEntrypoint, undefined, options);
}

export async function setConfigHost(
  host: string,
  cliEntrypoint: string,
  options: ConfigOperationOptions = {},
): Promise<string> {
  validateHost(host);
  const files = loadDevspaceFiles();
  writeDevspaceConfig({
    ...files.config,
    host,
    server: {
      ...(files.config.server ?? {}),
      host,
      port: files.config.server?.port ?? files.config.port,
    },
  });
  return applyConfigUpdate(
    cliEntrypoint,
    isPublicHost(host)
      ? "Warning: this host may expose DevSpace beyond localhost. Ensure auth, TLS, and firewall rules are correctly configured."
      : undefined,
    options,
  );
}

export async function setConfigDomain(
  input: string,
  cliEntrypoint: string,
  options: ConfigOperationOptions = {},
): Promise<string> {
  const normalized = normalizeDomainLikeInput(input);
  const files = loadDevspaceFiles();
  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalized.publicBaseUrl,
    server: {
      ...(files.config.server ?? {}),
      publicBaseUrl: normalized.publicBaseUrl,
      mcpPath: normalized.mcpPath,
    },
  });
  const warning = normalized.publicBaseUrl.startsWith("http://")
    ? "Warning: public URL uses HTTP. Prefer HTTPS for any remote MCP access."
    : undefined;
  return applyConfigUpdate(cliEntrypoint, warning, options);
}

export async function resetConfigKey(
  cliEntrypoint: string,
  options: ConfigOperationOptions = {},
): Promise<string> {
  const files = loadDevspaceFiles();
  const newToken = generateOwnerToken();
  writeDevspaceAuth({ ownerToken: newToken });

  const config = loadConfig();
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, new URL(config.mcpPath, config.publicBaseUrl));
  try {
    oauthProvider.resetState();

    const restartMessage = await applyConfigUpdate(cliEntrypoint, undefined, options);
    return [
      "Access key has been reset successfully.",
      "Existing clients must be reconfigured.",
      restartMessage,
    ].filter(Boolean).join("\n");
  } finally {
    oauthProvider.close();
  }
}

export async function addWorkspace(path: string, options: {
  create?: boolean;
  makeDefault?: boolean;
}): Promise<string> {
  const resolved = await resolveWorkspacePath(path, options.create ?? false);
  const files = loadDevspaceFiles();
  const current = new Set(files.config.workspaces?.allowed ?? files.config.allowedRoots ?? []);
  if (current.has(resolved)) {
    return `Workspace already added: ${resolved}`;
  }
  current.add(resolved);
  writeDevspaceConfig({
    ...files.config,
    allowedRoots: Array.from(current),
    workspaces: {
      allowed: Array.from(current),
      default: options.makeDefault ? resolved : files.config.workspaces?.default ?? null,
    },
  });
  return `Added workspace: ${resolved}`;
}

export function listWorkspaces(): { workspaces: string[]; defaultWorkspace?: string } {
  const files = loadDevspaceFiles();
  return {
    workspaces: files.config.workspaces?.allowed ?? files.config.allowedRoots ?? [],
    defaultWorkspace: files.config.workspaces?.default ?? undefined,
  };
}

export async function removeWorkspace(path: string): Promise<string> {
  const resolved = await resolveWorkspacePath(path, false);
  const files = loadDevspaceFiles();
  const remaining = (files.config.workspaces?.allowed ?? files.config.allowedRoots ?? []).filter((entry) => entry !== resolved);
  writeDevspaceConfig({
    ...files.config,
    allowedRoots: remaining,
    workspaces: {
      allowed: remaining,
      default: files.config.workspaces?.default === resolved ? null : files.config.workspaces?.default ?? null,
    },
  });
  return `Removed workspace: ${resolved}`;
}

export async function setDefaultWorkspace(path: string): Promise<string> {
  const resolved = await resolveWorkspacePath(path, false);
  const files = loadDevspaceFiles();
  const workspaces = files.config.workspaces?.allowed ?? files.config.allowedRoots ?? [];
  if (!workspaces.includes(resolved)) {
    throw new Error(`Workspace is not configured: ${resolved}`);
  }
  writeDevspaceConfig({
    ...files.config,
    workspaces: {
      allowed: workspaces,
      default: resolved,
    },
  });
  return `Default workspace set to ${resolved}`;
}

export async function clearDefaultWorkspace(): Promise<string> {
  const files = loadDevspaceFiles();
  writeDevspaceConfig({
    ...files.config,
    workspaces: {
      allowed: files.config.workspaces?.allowed ?? files.config.allowedRoots ?? [],
      default: null,
    },
  });
  return "Cleared default workspace";
}

function validateHost(host: string): void {
  const trimmed = host.trim();
  if (!trimmed) throw new Error("Host is required.");
  if (!/^(localhost|0\.0\.0\.0|127\.0\.0\.1|::1|::|[A-Za-z0-9._:-]+)$/.test(trimmed)) {
    throw new Error(`Invalid host: ${host}`);
  }
}

function isPublicHost(host: string): boolean {
  return !["127.0.0.1", "localhost", "::1"].includes(host);
}

function normalizeDomainLikeInput(input: string): { publicBaseUrl: string; mcpPath: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Domain or URL is required.");
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.username || parsed.password) {
    throw new Error("Public URL must not include a username or password.");
  }
  parsed.hash = "";
  parsed.search = "";
  const mcpPath = parsed.pathname.replace(/\/+$/, "") || "/mcp";
  parsed.pathname = "";
  return {
    publicBaseUrl: parsed.toString().replace(/\/$/, ""),
    mcpPath,
  };
}

async function applyConfigUpdate(
  cliEntrypoint: string,
  extraMessage?: string,
  options: ConfigOperationOptions = {},
): Promise<string> {
  const config = loadConfig();
  const manager = options.manager ?? createServiceManager({ config, cliEntrypoint });
  const outcome = await restartServiceIfRunning(manager);
  return [extraMessage, outcome.message].filter(Boolean).join("\n");
}

async function inspectPort(port: number): Promise<string | undefined> {
  const available = await canBindPort(port);
  return available ? undefined : ` by another process on this machine`;
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveWorkspacePath(path: string, create: boolean): Promise<string> {
  const target = resolve(expandHomePath(path));
  if (create) {
    await mkdir(target, { recursive: true });
  }
  if (!existsSync(target)) {
    throw new Error(`Workspace path does not exist: ${target}`);
  }
  return realpathSync(target);
}

function maskSecret(secret: string | undefined): string {
  if (!secret) return "(not configured)";
  if (secret.length <= 6) return "*".repeat(secret.length);
  return `${secret.slice(0, 3)}${"*".repeat(Math.max(8, secret.length - 5))}${secret.slice(-2)}`;
}

function effectiveOwnerToken(): string | undefined {
  const envToken = process.env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim();
  if (envToken) return envToken;
  return loadDevspaceFiles().auth.ownerToken;
}
