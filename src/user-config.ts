import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import * as z from "zod/v4";
import { harnessConfigSchema } from "./harness.js";
import {
  resolveSubagentsConfig,
  storedSubagentsConfigSchema,
  subagentsConfigSchema,
} from "./local-agent-config.js";
import { presentationConfigSchema } from "./presentation.js";
import { expandHomePath } from "./roots.js";

export const DEVSPACE_CONFIG_VERSION = 1 as const;
export const DEVSPACE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/Waishnav/devspace/refs/tags/v1.1.0/schema/devspace-config.schema.json";

const serverConfigSchema = z.object({
  host: z.string().optional().describe("Local bind host. Defaults to 127.0.0.1."),
  port: z.number().int().min(1).max(65535).optional().describe("Local MCP server port."),
  allowedRoots: z.array(z.string()).optional().describe("Project roots DevSpace may open."),
  publicBaseUrl: z.string().nullable().optional().describe("Public origin used by remote MCP hosts."),
  allowedHosts: z.array(z.string()).optional().describe("Optional HTTP Host allowlist."),
  stateDir: z.string().optional().describe("Directory containing persisted DevSpace state."),
  worktreeRoot: z.string().optional().describe("Directory for DevSpace-managed Git worktrees."),
});

const skillsConfigSchema = z.object({
  enabled: z.boolean().optional().describe("Whether skills are exposed to the host model."),
  paths: z.array(z.string()).optional().describe("Additional skill directories."),
  agentDir: z.string().optional().describe("Compatibility agent directory. Defaults to ~/.codex."),
});

const artifactsConfigSchema = z.object({
  enabled: z.boolean().optional().describe("Enable native MCP-host artifact download."),
  maxFileBytes: z.number().int().positive().optional().describe("Maximum bytes accepted for one artifact."),
});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).optional(),
  format: z.enum(["json", "pretty"]).optional(),
  requests: z.boolean().optional(),
  assets: z.boolean().optional(),
  toolCalls: z.boolean().optional(),
  shellCommands: z.boolean().optional(),
  trustProxy: z.boolean().optional(),
});

const oauthConfigSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().optional(),
  refreshTokenTtlSeconds: z.number().int().positive().optional(),
  scopes: z.array(z.string().min(1)).optional(),
  allowedRedirectHosts: z.array(z.string().min(1)).optional(),
});

export const devspaceConfigSchema = z.object({
  $schema: z.string().optional().describe("JSON Schema URL used by editors."),
  version: z.literal(DEVSPACE_CONFIG_VERSION),
  server: serverConfigSchema.optional(),
  harness: harnessConfigSchema.optional(),
  presentation: presentationConfigSchema.optional(),
  skills: skillsConfigSchema.optional(),
  artifacts: artifactsConfigSchema.optional(),
  subagents: subagentsConfigSchema.optional(),
  logging: loggingConfigSchema.optional(),
  oauth: oauthConfigSchema.optional(),
});

export function createDevspaceConfigJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(devspaceConfigSchema, { target: "draft-2020-12" }) as Record<string, unknown>),
    $id: DEVSPACE_CONFIG_SCHEMA_URL,
    title: "DevSpace configuration",
    description: "Versioned configuration for the DevSpace server and coding harness.",
  };
}

const legacyDevspaceUserConfigSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  allowedRoots: z.array(z.string()).optional(),
  publicBaseUrl: z.string().nullable().optional(),
  allowedHosts: z.array(z.string()).optional(),
  stateDir: z.string().optional(),
  worktreeRoot: z.string().optional(),
  artifactsEnabled: z.boolean().optional(),
  artifactMaxFileBytes: z.number().optional(),
  agentDir: z.string().optional(),
  subagents: storedSubagentsConfigSchema.optional(),
});

const devspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
});

export type DevspaceUserConfig = z.infer<typeof devspaceConfigSchema>;
export type DevspaceAuthConfig = z.infer<typeof devspaceAuthConfigSchema>;

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  legacyConfigPath: string;
  authPath: string;
  configExists: boolean;
  jsoncConfigExists: boolean;
  legacyConfigExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
  configDocument: Record<string, unknown>;
  configSourcePath?: string;
  configSourceText?: string;
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
  const configPath = join(dir, "config.jsonc");
  const legacyConfigPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const jsoncConfigExists = existsSync(configPath);
  const legacyConfigExists = existsSync(legacyConfigPath);
  const authExists = existsSync(authPath);
  const configSourcePath = jsoncConfigExists
    ? configPath
    : legacyConfigExists
      ? legacyConfigPath
      : undefined;
  const configSourceText = configSourcePath ? readFileSync(configSourcePath, "utf8") : undefined;
  const configDocument = configSourceText
    ? readConfigDocument(configSourceText, configSourcePath!, jsoncConfigExists)
    : {};
  const authDocument = authExists ? readJsonObject(authPath) : {};
  const config = jsoncConfigExists
    ? parseDocument(devspaceConfigSchema, configDocument, configPath)
    : legacyConfigExists
      ? migrateLegacyConfig(parseDocument(legacyDevspaceUserConfigSchema, configDocument, legacyConfigPath))
      : { version: DEVSPACE_CONFIG_VERSION };

  return {
    dir,
    configPath,
    legacyConfigPath,
    authPath,
    configExists: jsoncConfigExists || legacyConfigExists,
    jsoncConfigExists,
    legacyConfigExists,
    authExists,
    config,
    auth: parseDocument(devspaceAuthConfigSchema, authDocument, authPath),
    configDocument,
    configSourcePath,
    configSourceText,
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
  source: Pick<DevspaceFiles, "jsoncConfigExists" | "configSourceText"> | undefined = undefined,
): string {
  const filePath = devspaceConfigPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  const canonical = {
    ...config,
    $schema: DEVSPACE_CONFIG_SCHEMA_URL,
    version: DEVSPACE_CONFIG_VERSION,
  } satisfies DevspaceUserConfig;

  const existingJsonc = source?.jsoncConfigExists ? source.configSourceText : undefined;
  const content = existingJsonc
    ? updateJsoncDocument(existingJsonc, canonical)
    : JSON.stringify(canonical, null, 2) + "\n";
  writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function migrateLegacyConfig(config: z.infer<typeof legacyDevspaceUserConfigSchema>): DevspaceUserConfig {
  const server = compactObject({
    host: config.host,
    port: config.port,
    allowedRoots: config.allowedRoots,
    publicBaseUrl: config.publicBaseUrl,
    allowedHosts: config.allowedHosts,
    stateDir: config.stateDir,
    worktreeRoot: config.worktreeRoot,
  });
  const artifacts = compactObject({
    enabled: config.artifactsEnabled,
    maxFileBytes: config.artifactMaxFileBytes,
  });
  const skills = compactObject({ agentDir: config.agentDir });

  return {
    version: DEVSPACE_CONFIG_VERSION,
    ...(Object.keys(server).length > 0 ? { server } : {}),
    ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
    ...(config.subagents !== undefined
      ? { subagents: resolveSubagentsConfig(config.subagents, {}) }
      : {}),
  };
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function readConfigDocument(
  source: string,
  filePath: string,
  allowComments: boolean,
): Record<string, unknown> {
  if (!allowComments) return readJsonText(source, filePath);

  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const reason = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ");
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
  return assertRecord(parsed, filePath);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  return readJsonText(readFileSync(filePath, "utf8"), filePath);
}

function readJsonText(source: string, filePath: string): Record<string, unknown> {
  try {
    return assertRecord(JSON.parse(source) as unknown, filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function assertRecord(value: unknown, filePath: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unable to read ${filePath}: expected a configuration object`);
  }
  return value as Record<string, unknown>;
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  document: Record<string, unknown>,
  filePath: string,
): T {
  const result = schema.safeParse(document);
  if (result.success) return result.data;

  throw new Error(`Invalid ${filePath}: ${z.prettifyError(result.error)}`);
}

function updateJsoncDocument(source: string, config: DevspaceUserConfig): string {
  let updated = source;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

  for (const [path, value] of configEntries(config)) {
    updated = applyEdits(updated, modify(updated, path, value, { formattingOptions }));
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

function configEntries(config: DevspaceUserConfig): Array<[Array<string>, unknown]> {
  const entries: Array<[Array<string>, unknown]> = [
    [["$schema"], config.$schema],
    [["version"], config.version],
  ];

  const sectionKeys = {
    server: ["host", "port", "allowedRoots", "publicBaseUrl", "allowedHosts", "stateDir", "worktreeRoot"],
    harness: ["kind", "inspection"],
    presentation: ["mode"],
    skills: ["enabled", "paths", "agentDir"],
    artifacts: ["enabled", "maxFileBytes"],
    subagents: ["enabled", "providers"],
    logging: ["level", "format", "requests", "assets", "toolCalls", "shellCommands", "trustProxy"],
    oauth: ["accessTokenTtlSeconds", "refreshTokenTtlSeconds", "scopes", "allowedRedirectHosts"],
  } as const;

  for (const [section, keys] of Object.entries(sectionKeys) as Array<
    [keyof typeof sectionKeys, readonly string[]]
  >) {
    const value = config[section] as Record<string, unknown> | undefined;
    if (value === undefined) continue;
    for (const key of keys) {
      entries.push([[section, key], value?.[key]]);
    }
  }
  return entries;
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
