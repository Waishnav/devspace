import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface DevspaceUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
}

export interface DevspaceAuthConfig {
  ownerToken?: string;
}

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
}

export function devspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}

export function devspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);
  secureExistingConfigFiles(dir, configPath, authPath, configExists, authExists);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<DevspaceUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<DevspaceAuthConfig>(authPath) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceConfigPath(env);
  ensurePrivateDirectory(devspaceConfigDir(env));
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  ensurePrivateDirectory(devspaceConfigDir(env));
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
  if (process.platform !== "win32") chmodSync(filePath, mode);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function secureExistingConfigFiles(
  dir: string,
  configPath: string,
  authPath: string,
  configExists: boolean,
  authExists: boolean,
): void {
  if (process.platform === "win32" || !existsSync(dir)) return;
  chmodSync(dir, 0o700);
  if (configExists) chmodSync(configPath, 0o600);
  if (authExists) chmodSync(authPath, 0o600);
}
