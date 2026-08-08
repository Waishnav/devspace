import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentExecution,
  type ResolvedLocalAgentExecution,
} from "./local-agent-resolution.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
  json: boolean;
}

export type LocalAgentTarget = ResolvedLocalAgentExecution;

const USAGE =
  'Usage: devspace agents run <profile-or-provider-or-id> [--model <model>] [--effort <level>] "<prompt>"';

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const json = args.at(-1) === "--json";
  const [target, ...rest] = json ? args.slice(0, -1) : args;
  if (!target) {
    throw new Error(USAGE);
  }

  let model: string | undefined;
  let effort: string | undefined;
  const promptParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (part === "--model") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = part.slice("--model=".length).trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      continue;
    }
    if (part === "--effort" || part === "--thinking") {
      const flag = part;
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error(`Missing value for ${flag}.`);
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = part.slice("--effort=".length).trim();
      if (!value) throw new Error("Missing value for --effort.");
      effort = value;
      continue;
    }
    if (part?.startsWith("--thinking=")) {
      const value = part.slice("--thinking=".length).trim();
      if (!value) throw new Error("Missing value for --thinking.");
      effort = value;
      continue;
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(USAGE);
  }

  return { target, prompt, model, effort, json };
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  availableProviders: LocalAgentProvider[] = [...LOCAL_AGENT_PROVIDERS],
): LocalAgentTarget | undefined {
  try {
    return resolveLocalAgentExecution({
      target,
      prompt: "",
      profiles,
      availableProviders,
      model: modelOverride,
      effort: effortOverride,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "LocalAgentResolutionError") return undefined;
    throw error;
  }
}

export function formatAvailableLocalAgentTargets(
  profiles: LocalAgentProfile[],
  providers: LocalAgentProvider[] = [...LOCAL_AGENT_PROVIDERS],
): string {
  const profileNames = profiles.map((profile) => profile.name);
  const parts = [
    profileNames.length > 0 ? `profiles: ${profileNames.join(", ")}` : undefined,
    providers.length > 0 ? `providers: ${providers.join(", ")}` : "providers: none",
  ].filter(Boolean);
  return parts.join("; ");
}
