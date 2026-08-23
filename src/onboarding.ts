import type { SubagentsConfig } from "./local-agent-config.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add Waishnav/devspace --skill subagents --global";

export const ONBOARDING_DESTINATIONS = ["chatgpt", "coding-agents"] as const;
export type OnboardingDestination = typeof ONBOARDING_DESTINATIONS[number];
export type OnboardingUsage = OnboardingDestination | "both";

export function resolveOnboardingUsage(
  destinations: readonly OnboardingDestination[],
): OnboardingUsage {
  const selected = new Set(destinations);
  if (selected.has("chatgpt") && selected.has("coding-agents")) return "both";
  if (selected.has("chatgpt")) return "chatgpt";
  if (selected.has("coding-agents")) return "coding-agents";
  throw new Error("Choose ChatGPT, Coding Agents, or both.");
}

export function usesChatGpt(usage: OnboardingUsage): boolean {
  return usage === "chatgpt" || usage === "both";
}

export function usesCodingAgents(usage: OnboardingUsage): boolean {
  return usage === "coding-agents" || usage === "both";
}

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  return {
    enabled: true,
    providers: LOCAL_AGENT_PROVIDERS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);
        return {
          ...existing,
          id,
          enabled: selected.has(id),
        };
      }),
  };
}
