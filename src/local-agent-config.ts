import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  defaultDriverForProviderId,
  isLocalAgentDriverKind,
  isLegacyAcpDriverKind,
  LEGACY_ACP_DRIVER_KINDS,
  LOCAL_AGENT_DRIVER_KINDS,
  type LocalAgentDriverKind,
  type LocalAgentProviderInstanceId,
} from "./local-agent-provider.js";

const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string(),
);

const providerShape = {
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  env: environmentSchema.optional(),
};

const commandSchema = z.string()
  .regex(/\S/, "Command must contain a non-whitespace character")
  .trim()
  .min(1)
  .optional();

const acpConfigSchema = z.object({
  args: z.array(z.string()).optional(),
  flavor: z.enum(LEGACY_ACP_DRIVER_KINDS).optional(),
}).strict();

const inputDriverKinds = [...LOCAL_AGENT_DRIVER_KINDS, ...LEGACY_ACP_DRIVER_KINDS] as const;

const providerSchema = z.object({
  id: z.string().trim().min(1),
  driver: z.enum(inputDriverKinds).optional(),
  ...providerShape,
  command: commandSchema,
  config: acpConfigSchema.optional(),
}).strict().superRefine((provider, context) => {
  const driver = provider.driver
    ? (isLegacyAcpDriverKind(provider.driver) ? "acp" : provider.driver)
    : defaultDriverForProviderId(provider.id);
  if (!driver) {
    context.addIssue({
      code: "custom",
      path: ["driver"],
      message: `Subagent provider instance ${provider.id} must declare a driver.`,
    });
    return;
  }
  if ((driver === "opencode" || driver === "pi") && provider.command !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: `${driver} does not support a command override.`,
    });
  }
  if (driver !== "acp" && provider.config !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["config"],
      message: `${driver} does not support ACP config.`,
    });
  }
  if (driver === "acp" && !provider.command && !isLegacyAcpDriverKind(provider.id)) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: `ACP provider instance ${provider.id} must declare a command.`,
    });
  }
});

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  providers: z.array(providerSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProviderInstanceId>();
  for (const [index, provider] of value.providers.entries()) {
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate subagent provider: ${provider.id}`,
      });
    }
    seen.add(provider.id);
  }
});

export const storedSubagentsConfigSchema = z.union([
  z.boolean(),
  subagentsConfigSchema,
]);

type ParsedSubagentProviderConfig = z.infer<typeof providerSchema>;
type ParsedSubagentsConfig = z.infer<typeof subagentsConfigSchema>;

export interface SubagentProviderConfig extends Omit<ParsedSubagentProviderConfig, "driver"> {
  driver: LocalAgentDriverKind;
}

export interface SubagentsConfig extends Omit<ParsedSubagentsConfig, "providers"> {
  providers: SubagentProviderConfig[];
}

export type StoredSubagentsConfig = z.infer<typeof storedSubagentsConfigSchema>;

export function resolveSubagentsConfig(config: ParsedSubagentsConfig): SubagentsConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      driver: provider.driver
        ? (isLegacyAcpDriverKind(provider.driver) ? "acp" : provider.driver)
        : defaultDriverForProviderId(provider.id)!,
      ...(isLegacyAcpDriverKind(provider.id) && provider.config?.flavor === undefined
        ? { config: { ...provider.config, flavor: provider.id } }
        : {}),
    })),
  };
}

export function parseSubagentsConfig(value: unknown): SubagentsConfig {
  return resolveSubagentsConfig(subagentsConfigSchema.parse(value));
}

export function subagentProviderConfig(
  config: SubagentsConfig,
  providerInstanceId: LocalAgentProviderInstanceId,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === providerInstanceId);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  providerInstanceId: LocalAgentProviderInstanceId,
): boolean {
  return config.enabled && subagentProviderConfig(config, providerInstanceId)?.enabled === true;
}

export function localAgentProviderEnvironment(
  config: SubagentsConfig,
  providerInstanceId: LocalAgentProviderInstanceId,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const providerConfig = subagentProviderConfig(config, providerInstanceId);
  const env = { ...inherited, ...providerConfig?.env };
  const commandVariable = providerConfig ? providerCommandVariable(providerConfig.driver) : undefined;
  const command = providerConfig?.command;
  if (commandVariable && command) env[commandVariable] = command;
  return env;
}

export function localAgentProviderEnvironmentOverrides(
  config: SubagentsConfig,
  providerInstanceId: LocalAgentProviderInstanceId,
): Record<string, string> {
  return { ...subagentProviderConfig(config, providerInstanceId)?.env };
}

export function providerCommandVariable(driver: LocalAgentDriverKind): string | undefined {
  switch (driver) {
    case "codex": return "CODEX_COMMAND";
    case "claude": return "CLAUDE_COMMAND";
    case "opencode":
    case "pi":
    case "acp":
      return undefined;
  }
}

export function localAgentProviderConfigRevision(config: SubagentsConfig): string {
  const providers = [...config.providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => ({
      id: provider.id,
      driver: provider.driver,
      enabled: provider.enabled,
      ...(provider.model ? { model: provider.model } : {}),
      ...(provider.effort ? { effort: provider.effort } : {}),
      ...("command" in provider && provider.command ? { command: provider.command } : {}),
      ...(provider.env && Object.keys(provider.env).length > 0
        ? {
            env: Object.fromEntries(
              Object.entries(provider.env).sort(([left], [right]) => left.localeCompare(right)),
            ),
          }
        : {}),
      ...(provider.config ? { config: provider.config } : {}),
    }));
  return createHash("sha256")
    .update(JSON.stringify({ enabled: config.enabled, providers }))
    .digest("hex");
}
