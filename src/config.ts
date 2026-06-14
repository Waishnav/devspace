import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { AutoCommitConfig, AutoCommitProviderId } from "./autocommit/types.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";

export type ToolNamingMode = "legacy" | "short";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_AUTOCOMMIT_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_AUTOCOMMIT_CODEX_REASONING_EFFORT = "low";

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  toolNaming: ToolNamingMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  logging: LoggingConfig;
  autocommit: AutoCommitConfig;
}

function parsePort(value: string | undefined): number {
  if (!value) return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | undefined): string[] {
  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | undefined): string[] {
  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return rawHosts.length > 0 ? rawHosts : ["localhost", "127.0.0.1"];
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(env: NodeJS.ProcessEnv): boolean {
  return env.DEVSPACE_TOOL_MODE === "minimal" || parseBoolean(env.DEVSPACE_MINIMAL_TOOLS);
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHomePath(entry))) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseAutoCommitProvider(value: string | undefined): AutoCommitProviderId {
  const provider = value?.trim() || "codex";
  if (provider !== "pi" && provider !== "codex") {
    throw new Error(`Invalid DEVSPACE_AUTOCOMMIT_PROVIDER: ${provider}`);
  }

  return provider;
}

function parseAutoCommitConfig(env: NodeJS.ProcessEnv): AutoCommitConfig {
  const provider = parseAutoCommitProvider(env.DEVSPACE_AUTOCOMMIT_PROVIDER);
  return {
    enabled: parseBoolean(env.DEVSPACE_AUTOCOMMIT),
    provider,
    afterMutatingToolCalls: parsePositiveInteger(
      env.DEVSPACE_AUTOCOMMIT_AFTER,
      8,
      "DEVSPACE_AUTOCOMMIT_AFTER",
    ),
    includeUntracked: parseBoolean(env.DEVSPACE_AUTOCOMMIT_INCLUDE_UNTRACKED),
    maxDiffBytes: parsePositiveInteger(
      env.DEVSPACE_AUTOCOMMIT_MAX_DIFF_BYTES,
      200_000,
      "DEVSPACE_AUTOCOMMIT_MAX_DIFF_BYTES",
    ),
    refPrefix: env.DEVSPACE_AUTOCOMMIT_REF_PREFIX ?? "refs/devspace/autocommit",
    model:
      env.DEVSPACE_AUTOCOMMIT_MODEL ??
      (provider === "codex" ? DEFAULT_AUTOCOMMIT_MODEL : undefined),
    codexReasoningEffort:
      env.DEVSPACE_AUTOCOMMIT_CODEX_REASONING_EFFORT ??
      DEFAULT_AUTOCOMMIT_CODEX_REASONING_EFFORT,
    codexFastMode: parseBoolean(env.DEVSPACE_AUTOCOMMIT_CODEX_FAST),
  };
}

function parseToolNaming(value: string | undefined): ToolNamingMode {
  if (!value || value === "legacy") return "legacy";
  if (value === "short") return "short";

  throw new Error(`Invalid DEVSPACE_TOOL_NAMING: ${value}`);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "changes") return "changes";
  if (value === "off" || value === "full") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Generate one with: openssl rand -base64 32`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT),
    oauth: parseOAuthConfig(env),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS),
    publicBaseUrl: env.DEVSPACE_PUBLIC_BASE_URL ?? "https://agent.gitcms.blog",
    minimalTools: parseMinimalTools(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: resolve(env.DEVSPACE_STATE_DIR ?? defaultStateDir()),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? defaultWorktreeRoot())),
    skillsEnabled: parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
    autocommit: parseAutoCommitConfig(env),
  };
}
