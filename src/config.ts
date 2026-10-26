import { resolve } from "node:path";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles, type DevspaceFiles } from "./user-config.js";
import {
  disabledSubagentsConfig,
  implicitSubagentsConfig,
  resolveSubagentsConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";

export type { ToolMode } from "./config-schema.js";

/** What `devspace agents` and the agent daemon need. They run without OAuth, a public URL, or a server. */
export interface AgentConfig {
  configDir: string;
  allowedRoots: string[];
  stateDir: string;
  worktreeRoot: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
}

export interface ServerConfig extends AgentConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  uiEnabled: boolean;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  logging: LoggingConfig;
}

/**
 * Agent commands need no server setup. Without a `subagents` key they detect the installed
 * coding agents; an explicit `subagents` config, including `enabled: false`, always wins.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const files = loadDevspaceFiles(env);
  const { subagents } = files.config;
  return agentConfig(files, env, subagents ? resolveSubagentsConfig(subagents) : implicitSubagentsConfig());
}

function agentConfig(files: DevspaceFiles, env: NodeJS.ProcessEnv, subagents: SubagentsConfig): AgentConfig {
  const stored = files.config;
  return {
    configDir: files.dir,
    allowedRoots: normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]),
    stateDir: normalizePath(stored.storage.stateDir),
    worktreeRoot: normalizePath(stored.workspaces.worktreeRoot),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents,
    agentDir: normalizePath(stored.skills.agentDir),
  };
}

/** Strict config for `devspace serve`: requires the owner token. Subagents stay an explicit opt-in. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const host = stored.server.host;
  const port = stored.server.port;
  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  return {
    ...agentConfig(files, env, resolveSubagentsConfig(stored.subagents ?? disabledSubagentsConfig())),
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      scopes: stored.oauth.scopes,
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
    },
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    toolMode: stored.tools.mode,
    uiEnabled: stored.ui.enabled,
    artifactsEnabled: stored.artifacts.enabled,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: stored.skills.enabled,
    skillPaths: stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
  };
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: devspace init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
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
