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
    publicUrl: buildMcpUrl(settings.publicBaseUrl),
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
    message: `Updated public domain to ${new URL(publicBaseUrl).hostname}. MCP URL: ${buildMcpUrl(publicBaseUrl)}. Restart DevSpace for the change to take effect.`,
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

  const publicBaseUrl = normalizeConfiguredPublicBaseUrl(trimmed);
  writeDevspaceConfig({ ...files.config, publicBaseUrl }, env);
  return {
    message: `Updated public base URL to ${publicBaseUrl}. MCP URL: ${buildMcpUrl(publicBaseUrl)}. Restart DevSpace for the change to take effect.`,
  };
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
  const labels = host.split(".");
  if (
    host.length > 253
    || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
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

function normalizeConfiguredPublicBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("publicBaseUrl must use http or https.");
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof Error && error.message === "publicBaseUrl must use http or https.") {
      throw error;
    }
    throw new Error("publicBaseUrl must be a valid http or https URL.");
  }
}

function buildMcpUrl(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${MCP_PATH}`;
  return url.toString();
}

function maskSecret(secret: string | undefined): string {
  return secret ? "********" : "(not configured)";
}
