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
  tool_mode: z.enum(["claude", "codex"]).optional(),
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
  ui: z.object({
    enabled: z.boolean().optional(),
  }).strict().optional(),
}).passthrough();

const LEGACY_CONFIG_KEYS = new Set([
  "host",
  "port",
  "tool_mode",
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
  "ui",
]);

export function migrateLegacyConfig(value: LegacyConfigInput): DevspaceConfig {
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
    tools: definedEntries({ mode: legacy.tools?.mode ?? legacy.tool_mode }),
    ui: definedEntries({ enabled: legacy.ui?.enabled }),
    artifacts: definedEntries({
      enabled: legacy.artifactsEnabled,
      maxFileBytes: legacy.artifactMaxFileBytes,
    }),
    skills: definedEntries({ agentDir: legacy.agentDir }),
    subagents: migrateLegacySubagents(legacy.subagents),
  });
}

export type LegacyConfigInput = z.input<typeof legacyConfigSchema>;

function definedEntries<T extends Record<string, unknown>>(value: T): Partial<T> {
  // SAFETY: Object.entries preserves the keys of the owned record while removing only undefined values.
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Partial<T>;
}

function migrateLegacySubagents(
  value: z.infer<typeof storedSubagentsConfigSchema> | undefined,
): z.infer<typeof devspaceConfigSchema>["subagents"] | undefined {
  if (value === undefined) return undefined;

  if (value !== true && value !== false) return value;

  return {
    enabled: value,
    instructions: "on-demand",
    providers: value
      ? LOCAL_AGENT_PROVIDERS.map((id) => ({ id, enabled: true }))
      : [],
  };
}
