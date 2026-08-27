import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const providerSchema = z.object({
  id: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
}).strict();

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

export function resolveSubagentsConfig(
  value: unknown,
): SubagentsConfig {
  return value === undefined
    ? { enabled: false, providers: [] }
    : subagentsConfigSchema.parse(value);
}

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
