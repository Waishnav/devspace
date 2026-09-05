import * as z from "zod/v4";
import {
  DEVSPACE_CONFIG_VERSION,
  devspaceConfigSchema,
  type DevspaceConfig,
} from "./config-schema.js";
import { storedSubagentsConfigSchema } from "./local-agent-config.js";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";

const legacyConfigSchema = z.object({
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
  tools: z.object({
    mode: z.enum(["claude", "codex"]).optional(),
  }).strict().optional(),
  "tools.mode": z.enum(["claude", "codex"]).optional(),
  ui: z.object({
    enabled: z.boolean().optional(),
  }).strict().optional(),
}).passthrough();

const LEGACY_CONFIG_KEYS = new Set([
  "host",
  "port",
  "allowedRoots",
  "publicBaseUrl",
  "allowedHosts",
  "stateDir",
  "worktreeRoot",
  "artifactsEnabled",
  "artifactMaxFileBytes",
  "agentDir",
  "subagents",
  "tools",
  "tools.mode",
  "ui",
]);

export function migrateLegacyConfig(value: unknown): DevspaceConfig {
  const legacy = legacyConfigSchema.parse(value);
  const unsupportedKeys = Object.keys(legacy).filter((key) => !LEGACY_CONFIG_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Unsupported legacy configuration keys: ${unsupportedKeys.sort().join(", ")}`,
    );
  }

  return devspaceConfigSchema.parse({
    configVersion: DEVSPACE_CONFIG_VERSION,
    server: definedEntries({
      host: legacy.host,
      port: legacy.port,
      publicBaseUrl: legacy.publicBaseUrl,
      allowedHosts: legacy.allowedHosts,
    }),
    workspaces: definedEntries({
      allowedRoots: legacy.allowedRoots,
      worktreeRoot: legacy.worktreeRoot,
    }),
    storage: definedEntries({ stateDir: legacy.stateDir }),
    tools: definedEntries({ mode: legacy.tools?.mode ?? legacy["tools.mode"] }),
    ui: definedEntries({ enabled: legacy.ui?.enabled }),
    artifacts: definedEntries({
      enabled: legacy.artifactsEnabled,
      maxFileBytes: legacy.artifactMaxFileBytes,
    }),
    skills: definedEntries({ agentDir: legacy.agentDir }),
    subagents: migrateLegacySubagents(legacy.subagents),
  });
}

function definedEntries<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Partial<T>;
}

function migrateLegacySubagents(
  value: z.infer<typeof storedSubagentsConfigSchema> | undefined,
): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return value;
  return {
    enabled: value,
    providers: value
      ? LOCAL_AGENT_PROVIDERS.map((id) => ({ id, enabled: true }))
      : [],
  };
}
