import { isIP } from "node:net";
import { loadServerSettings } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import {
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
} from "./user-config.js";

const MCP_PATH = "/mcp";

export interface ConfigShowResult {
  host: string;
  port: number;
  publicBaseUrl: string;
  publicUrl: string;
  allowedHosts: string[];
  accessKey: string;
  configPath: string;
  authPath: string;
}

export interface ConfigUpdateResult {
  message: string;
  warning?: string;
}

export interface ConfigKeyUpdateResult {
  authPath: string;
}

export function buildConfigShowResult(env: NodeJS.ProcessEnv = process.env): ConfigShowResult {
  const settings = loadServerSettings(env);
  const files = loadDevspaceFiles(env);
  const ownerToken = env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim() || files.auth.ownerToken;

  return {
    host: settings.host,
    port: settings.port,
    publicBaseUrl: settings.publicBaseUrl,
    publicUrl: new URL(MCP_PATH, settings.publicBaseUrl).toString(),
    allowedHosts: settings.allowedHosts,
    accessKey: maskSecret(ownerToken),
    configPath: files.configPath,
    authPath: files.authPath,
  };
}

export function setConfigPort(
  value: string | number,
  env: NodeJS.ProcessEnv = process.env,
): ConfigUpdateResult {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }

  const files = loadDevspaceFiles(env);
  writeDevspaceConfig({ ...files.config, port }, env);
  return {
    message: `Updated local bind port to ${port}. Restart DevSpace for the change to take effect.`,
  };
}

export function setConfigHost(value: string, env: NodeJS.ProcessEnv = process.env): ConfigUpdateResult {
  const host = validateHost(value);
  const files = loadDevspaceFiles(env);
  writeDevspaceConfig({ ...files.config, host }, env);

  return {
    message: `Updated local bind host to ${host}. Restart DevSpace for the change to take effect.`,
    warning: isPublicHost(host)
      ? "Warning: this host may expose DevSpace beyond localhost. Ensure HTTPS, authentication, and firewall rules are configured."
      : undefined,
  };
}

export function setConfigDomain(value: string, env: NodeJS.ProcessEnv = process.env): ConfigUpdateResult {
  const publicBaseUrl = normalizeConfiguredDomain(value);
  const files = loadDevspaceFiles(env);
  writeDevspaceConfig({ ...files.config, publicBaseUrl }, env);

  return {
    message: `Updated public domain to ${new URL(publicBaseUrl).hostname}. MCP URL: ${new URL(MCP_PATH, publicBaseUrl).toString()}. Restart DevSpace for the change to take effect.`,
  };
}

export function setConfigPublicBaseUrl(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigUpdateResult {
  const trimmed = value.trim();
  const files = loadDevspaceFiles(env);

  if (!trimmed || trimmed === "null" || trimmed === "none") {
    writeDevspaceConfig({ ...files.config, publicBaseUrl: null }, env);
    return {
      message: "Cleared the persisted public base URL. Restart DevSpace for the change to take effect.",
    };
  }

  return setConfigDomain(trimmed, env);
}

export function setConfigKey(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigKeyUpdateResult {
  if (env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim()) {
    throw new Error(
      "Cannot update the persisted Owner password while DEVSPACE_OAUTH_OWNER_TOKEN is set. Unset it first, then run `devspace config key <owner-password>` again.",
    );
  }

  const ownerToken = validateOwnerToken(value);
  const stateDir = loadServerSettings(env).stateDir;
  const store = new SqliteOAuthStore(stateDir);

  try {
    store.clearAll();
  } finally {
    store.close();
  }

  const authPath = writeDevspaceAuth({ ownerToken }, env);
  return { authPath };
}

function validateOwnerToken(value: string): string {
  const ownerToken = value.trim();
  if (!ownerToken) {
    throw new Error("Owner password is required. Use `devspace config key <owner-password>`.");
  }
  if (ownerToken.length < 16) {
    throw new Error("Owner password must be at least 16 characters long.");
  }
  return ownerToken;
}

function validateHost(value: string): string {
  const host = value.trim();
  if (!host) throw new Error("Host is required.");
  if (host.includes("://") || host.includes("/") || /\s/.test(host)) {
    throw new Error(`Invalid host: ${value}`);
  }
  if (isIP(host) !== 0 || host === "localhost") return host;
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new Error(`Invalid host: ${value}`);
  }
  return host;
}

function isPublicHost(host: string): boolean {
  return !["127.0.0.1", "localhost", "::1"].includes(host);
}

function normalizeConfiguredDomain(value: string): string {
  const domain = value.trim();
  if (!domain) throw new Error("Domain is required.");
  if (/[/:?#@]/.test(domain) || /\s/.test(domain)) {
    throw new Error("Domain must be a hostname without a protocol, port, path, query string, or fragment.");
  }

  const host = validateHost(domain);
  return `https://${host}`;
}

function maskSecret(secret: string | undefined): string {
  if (!secret) return "(not configured)";
  if (secret.length <= 6) return "*".repeat(secret.length);
  return `${secret.slice(0, 3)}${"*".repeat(Math.max(8, secret.length - 5))}${secret.slice(-2)}`;
}
