import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import { resolveSubagentsConfig, type SubagentsConfig } from "./local-agent-config.js";
import {
  harnessFromLegacyToolMode,
  type HarnessConfig,
  type LegacyToolMode,
} from "./harness.js";
import {
  presentationFromLegacyWidgetMode,
  type LegacyWidgetMode,
  type PresentationConfig,
} from "./presentation.js";

const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  harness: HarnessConfig;
  presentation: PresentationConfig;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}

function parseLegacyToolModeOverride(env: NodeJS.ProcessEnv): LegacyToolMode | undefined {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS, "DEVSPACE_MINIMAL_TOOLS") ? "minimal" : "full";
  }
  return undefined;
}

function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (!value) return fallback;
  if (value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined, fallback: LogFormat = "json"): LogFormat {
  if (!value) return fallback;
  if (value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(
  env: NodeJS.ProcessEnv,
  stored: Partial<LoggingConfig> = {},
): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL, stored.level),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT, stored.format),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined
      ? stored.requests ?? true
      : parseBoolean(env.DEVSPACE_LOG_REQUESTS, "DEVSPACE_LOG_REQUESTS"),
    assets: env.DEVSPACE_LOG_ASSETS === undefined
      ? stored.assets ?? false
      : parseBoolean(env.DEVSPACE_LOG_ASSETS, "DEVSPACE_LOG_ASSETS"),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined
      ? stored.toolCalls ?? true
      : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS, "DEVSPACE_LOG_TOOL_CALLS"),
    shellCommands: env.DEVSPACE_LOG_SHELL_COMMANDS === undefined
      ? stored.shellCommands ?? false
      : parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS, "DEVSPACE_LOG_SHELL_COMMANDS"),
    trustProxy: env.DEVSPACE_TRUST_PROXY === undefined
      ? stored.trustProxy ?? false
      : parseBoolean(env.DEVSPACE_TRUST_PROXY, "DEVSPACE_TRUST_PROXY"),
  };
}

function parseLegacyWidgetModeOverride(value: string | undefined): LegacyWidgetMode | undefined {
  if (!value) return undefined;
  if (value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(
  env: NodeJS.ProcessEnv,
  ownerToken: string | undefined,
  stored: {
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
    scopes?: string[];
    allowedRedirectHosts?: string[];
  } = {},
): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? numberConfigValue(stored.accessTokenTtlSeconds),
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS ?? numberConfigValue(stored.refreshTokenTtlSeconds),
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, stored.scopes ?? ["devspace"]),
    allowedRedirectHosts: parseStringList(
      env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS,
      stored.allowedRedirectHosts ?? ["chatgpt.com", "localhost", "127.0.0.1"],
    ),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const storedServer = files.config.server ?? {};
  const storedSkills = files.config.skills ?? {};
  const storedArtifacts = files.config.artifacts ?? {};
  const host = env.HOST ?? storedServer.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? storedServer.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? storedServer.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(storedServer.allowedHosts ?? []),
  ];
  const legacyToolMode = parseLegacyToolModeOverride(env);
  const legacyWidgetMode = parseLegacyWidgetModeOverride(env.DEVSPACE_WIDGETS);

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken, files.config.oauth),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? storedServer.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    harness: legacyToolMode
      ? harnessFromLegacyToolMode(legacyToolMode)
      : files.config.harness ?? { kind: "claude-code", inspection: "shell" },
    presentation: legacyWidgetMode
      ? presentationFromLegacyWidgetMode(legacyWidgetMode)
      : files.config.presentation ?? { mode: "inline" },
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? storedServer.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? storedServer.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled:
      env.DEVSPACE_ARTIFACTS === undefined
        ? storedArtifacts.enabled === true
        : parseBoolean(env.DEVSPACE_ARTIFACTS, "DEVSPACE_ARTIFACTS"),
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(storedArtifacts.maxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined
      ? storedSkills.enabled ?? true
      : parseBoolean(env.DEVSPACE_SKILLS, "DEVSPACE_SKILLS"),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS, storedSkills.paths ?? []),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: resolveSubagentsConfig(files.config.subagents, env),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? storedSkills.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env, files.config.logging),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
