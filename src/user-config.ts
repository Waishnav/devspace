import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import * as z from "zod/v4";
import {
  defaultDevspaceConfig,
  devspaceConfigSchema,
  type DevspaceConfig,
  type DevspaceConfigInput,
} from "./config-schema.js";
import { migrateLegacyConfig } from "./config-migration.js";
import { expandHomePath } from "./roots.js";

const devspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export type DevspaceUserConfig = DevspaceConfig;
export type DevspaceAuthConfig = z.infer<typeof devspaceAuthConfigSchema>;

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceConfig;
  auth: DevspaceAuthConfig;
  migratedLegacyConfig: boolean;
}

export interface DevspaceConfigEdit {
  path: (string | number)[];
  value: unknown;
}

export function devspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}

export function devspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.jsonc");
}

export function devspaceLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceLegacyConfigBackupPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json.v1.0.bak");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function devspaceSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "skills");
}

export function devspaceAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "agents");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = devspaceConfigPath(env);
  const legacyConfigPath = devspaceLegacyConfigPath(env);
  const authPath = devspaceAuthPath(env);
  const migratedLegacyConfig = !existsSync(configPath) && existsSync(legacyConfigPath)
    ? migrateLegacyConfigFile(legacyConfigPath, configPath, devspaceLegacyConfigBackupPath(env))
    : false;
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsoncConfig(configPath) : defaultDevspaceConfig(),
    auth: authExists ? readJsonFile(authPath, devspaceAuthConfigSchema) : {},
    migratedLegacyConfig,
  };
}

export function writeDevspaceConfig(
  config: DevspaceConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceConfigPath(env);
  const parsed = devspaceConfigSchema.parse(config);
  atomicWrite(filePath, serializeConfig(parsed), 0o600);
  return filePath;
}

export function setDevspaceConfigValue(
  path: (string | number)[],
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return setDevspaceConfigValues([{ path, value }], env);
}

export function setDevspaceConfigValues(
  edits: DevspaceConfigEdit[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = loadDevspaceFiles(env);
  const source = files.configExists
    ? readFileSync(files.configPath, "utf8")
    : serializeConfig(files.config);
  const updated = edits.reduce(
    (document, edit) => applyEdits(document, modify(document, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })),
    source,
  );
  parseJsoncConfig(updated, files.configPath);
  atomicWrite(files.configPath, updated.endsWith("\n") ? updated : `${updated}\n`, 0o600);
  return files.configPath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, devspaceAuthConfigSchema.parse(auth), 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function migrateLegacyConfigFile(
  legacyPath: string,
  configPath: string,
  backupPath: string,
): boolean {
  if (existsSync(backupPath)) {
    throw new Error(
      `Unable to migrate ${legacyPath}: backup already exists at ${backupPath}. `
      + `Move ${backupPath} out of the way, then run DevSpace again.`,
    );
  }

  let migrated: DevspaceConfig;
  try {
    migrated = migrateLegacyConfig(JSON.parse(readFileSync(legacyPath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("migrate", legacyPath, error);
  }

  const temporaryPath = temporaryFilePath(configPath);
  let published = false;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(temporaryPath, serializeConfig(migrated), { mode: 0o600, flag: "wx" });
    readJsoncConfig(temporaryPath);
    try {
      // A hard link publishes the complete temporary file atomically without
      // replacing config.jsonc if another first-start process won the race.
      linkSync(temporaryPath, configPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      readJsoncConfig(configPath);
      return false;
    }
    published = true;
    renameSync(legacyPath, backupPath);
  } catch (error) {
    if (published && existsSync(legacyPath)) {
      rmSync(configPath, { force: true });
    }
    throw fileError("migrate", legacyPath, error);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return true;
}

function readJsoncConfig(filePath: string): DevspaceConfig {
  try {
    return parseJsoncConfig(readFileSync(filePath, "utf8"), filePath);
  } catch (error) {
    if (error instanceof DevspaceConfigFileError) throw error;
    throw fileError("read", filePath, error);
  }
}

function parseJsoncConfig(source: string, filePath: string): DevspaceConfig {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new DevspaceConfigFileError(
      `Unable to read ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  try {
    return devspaceConfigSchema.parse(value);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function serializeConfig(config: DevspaceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function atomicWrite(filePath: string, source: string, mode: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = temporaryFilePath(filePath);
  try {
    writeFileSync(temporaryPath, source, { mode, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function temporaryFilePath(filePath: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function fileError(action: "read" | "migrate", filePath: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new DevspaceConfigFileError(`Unable to ${action} ${filePath}: ${reason}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class DevspaceConfigFileError extends Error {}
