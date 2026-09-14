import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string(),
);

const providerFields = {
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

const providerRevisionSchema = z.object({
  id: z.enum(["codex", "claude", "cursor", "copilot", "grok", "opencode", "pi"]),
  enabled: z.boolean(),
  model: z.string().optional(),
  effort: z.string().optional(),
  command: z.string().optional(),
  env: environmentSchema.optional(),
}).strict();

type ProviderEnvironment = z.output<typeof environmentSchema>;

type ProviderRevision = z.output<typeof providerRevisionSchema>;

const providerSchema = z.discriminatedUnion("id", [
  z.object({
    id: z.enum(["codex", "claude", "cursor", "copilot", "grok"]),
    ...providerFields,
    command: commandSchema,
  }).strict(),
  z.object({
    id: z.enum(["opencode", "pi"]),
    ...providerFields,
  }).strict(),
]);

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  providers: z.array(providerSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProvider>();

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

export type SubagentProviderConfig = z.infer<typeof providerSchema>;

export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;

export type StoredSubagentsConfig = z.infer<typeof storedSubagentsConfigSchema>;

export function subagentProviderConfig(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === provider);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): boolean {
  return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}

export function localAgentProviderEnvironment(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const providerConfig = subagentProviderConfig(config, provider);
  const env = { ...inherited, ...providerConfig?.env };
  const commandVariable = providerCommandVariable(provider);
  const command = providerConfig ? configuredProviderCommand(providerConfig) : undefined;

  if (commandVariable && command) env[commandVariable] = command;

  return env;
}

export function localAgentProviderEnvironmentOverrides(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): NodeJS.ProcessEnv {
  return { ...subagentProviderConfig(config, provider)?.env };
}

export function providerCommandVariable(provider: LocalAgentProvider): string | undefined {
  switch (provider) {
    case "codex": return "CODEX_COMMAND";
    case "claude": return "CLAUDE_COMMAND";
    case "cursor": return "CURSOR_COMMAND";
    case "copilot": return "COPILOT_COMMAND";
    case "grok": return "GROK_COMMAND";
    case "opencode":
    case "pi":
      return undefined;
  }
}

export function localAgentProviderConfigRevision(config: SubagentsConfig): string {
  const providers = [...config.providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(providerRevision);

  return createHash("sha256")
    .update(JSON.stringify({ enabled: config.enabled, providers }))
    .digest("hex");
}

function configuredProviderCommand(provider: SubagentProviderConfig): string | undefined {
  return "command" in provider ? provider.command : undefined;
}

function providerRevision(provider: SubagentProviderConfig): ProviderRevision {
  return providerRevisionSchema.parse({
    id: provider.id,
    enabled: provider.enabled,
    model: provider.model || undefined,
    effort: provider.effort || undefined,
    command: configuredProviderCommand(provider) || undefined,
    env: sortedProviderEnvironment(provider.env),
  });
}

function sortedProviderEnvironment(
  environment: ProviderEnvironment | undefined,
): ProviderEnvironment | undefined {
  if (environment === undefined || Object.keys(environment).length === 0) return undefined;

  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  );
}
