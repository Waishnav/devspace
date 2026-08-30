import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string(),
);

const providerSchema = z.object({
  id: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  command: z.string()
    .regex(/\S/, "Command must contain a non-whitespace character")
    .trim()
    .min(1)
    .optional(),
  env: environmentSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.id === "opencode" || value.id === "pi") && (value.command || value.env)) {
    context.addIssue({
      code: "custom",
      message: `${value.id} is embedded and does not support command or env configuration.`,
    });
  }
});

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
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
  if (commandVariable && providerConfig?.command) env[commandVariable] = providerConfig.command;
  return env;
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
