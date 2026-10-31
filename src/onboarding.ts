import type { SubagentsConfig } from "./local-agent-config.js";
import {
  defaultDriverForProviderId,
  LOCAL_AGENT_DEFAULT_PROVIDER_IDS,
  type LocalAgentProviderInstanceId,
} from "./local-agent-provider.js";

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
  selectedProviders: readonly LocalAgentProviderInstanceId[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  const defaultIds = new Set<string>(LOCAL_AGENT_DEFAULT_PROVIDER_IDS);

  const customInstances = current.providers
    .filter((provider) => !defaultIds.has(provider.id))
    .map((provider) => ({ ...provider, enabled: selected.has(provider.id) }));

  return {
    enabled: true,
    instructions: current.instructions,
    providers: [
      ...LOCAL_AGENT_DEFAULT_PROVIDER_IDS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);

        return {
          ...existing,
          id,
          driver: existing?.driver ?? defaultDriverForProviderId(id)!,
          enabled: selected.has(id),
        };
      }),
      ...customInstances,
    ],
  };
}

/**
 * `devspace init` options. Each flag answers one setup question; `--yes` takes
 * the defaults for the rest. A public URL is what additionally serves an MCP host.
 */
export interface InitFlags {
  force: boolean;
  yes: boolean;
  json: boolean;
  providers?: string[];
  roots?: string[];
  publicUrl?: string;
}

export const INIT_USAGE =
  "Usage: devspace init [--yes] [--providers <id,...>] [--public-url <url>] [--roots <path,...>] [--force] [--json]";

const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function parseInitArgs(args: readonly string[]): InitFlags {
  const flags: InitFlags = { force: false, yes: false, json: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    const value = () => {
      const next = inline ?? args[++i];

      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value.\n${INIT_USAGE}`);

      return next;
    };

    switch (name) {
      case "--force": flags.force = true; break;
      case "--yes": case "-y": flags.yes = true; break;
      case "--json": flags.json = true; break;
      case "--providers": flags.providers = list(value()); break;
      case "--roots": flags.roots = list(value()); break;
      case "--public-url": flags.publicUrl = value().trim(); break;
      default: throw new Error(`Unknown option: ${arg}\n${INIT_USAGE}`);
    }
  }

  return flags;
}

/** Setup runs without prompts when asked to, when given answers, or when nobody can answer. */
export function isNonInteractiveInit(flags: InitFlags, interactiveTerminal: boolean): boolean {
  return flags.yes || flags.json || !interactiveTerminal
    || [flags.providers, flags.roots, flags.publicUrl].some((value) => value !== undefined);
}

export interface InitAnswers {
  usage: OnboardingUsage;
  providers: string[];
  /** Raw root paths; set only when DevSpace serves an MCP host. */
  roots?: string[];
  /** Raw public URL; set only when DevSpace serves an MCP host. */
  publicUrl?: string;
}

export interface InitDefaults {
  providers: string[];
  knownProviders: string[];
  roots: string[];
  publicUrl: string | null;
}

/**
 * Fill unanswered flags with the defaults the prompts preselect. Subagents are
 * always set up; a public URL, given or already saved, also serves an MCP host.
 */
export function resolveInitAnswers(flags: InitFlags, defaults: InitDefaults): InitAnswers {
  const providers = flags.providers ?? defaults.providers;
  const unknown = providers.filter((id) => !defaults.knownProviders.includes(id));

  if (unknown.length > 0) {
    throw new Error(`Unknown provider: ${unknown.join(", ")}. Known providers: ${defaults.knownProviders.join(", ")}.`);
  }

  if (providers.length === 0) {
    throw new Error("No coding agents were detected. Install one, or pass --providers <id,...>.");
  }

  const publicUrl = flags.publicUrl ?? defaults.publicUrl;

  if (!publicUrl) {
    if (flags.roots) throw new Error("--roots needs --public-url: project folders apply only when an MCP host connects.");

    return { usage: "coding-agents", providers };
  }

  return { usage: "both", providers, roots: flags.roots ?? defaults.roots, publicUrl };
}
