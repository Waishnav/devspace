import {
  isLocalAgentProvider,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import { createHash } from "node:crypto";

export type LocalAgentResolutionErrorKind =
  | "target_not_found"
  | "profile_not_found"
  | "provider_unavailable"
  | "no_provider";

export class LocalAgentResolutionError extends Error {
  constructor(
    readonly kind: LocalAgentResolutionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentResolutionError";
  }
}

export interface ResolvedLocalAgentExecution {
  kind: "profile" | "provider";
  name: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  prompt: string;
  profile?: LocalAgentProfile;
  profileName?: string;
  profileFingerprint?: string;
}

export interface ResolveLocalAgentExecutionInput {
  prompt: string;
  profiles: LocalAgentProfile[];
  availableProviders: LocalAgentProvider[];
  /** CLI-style target. Profiles shadow a raw provider with the same name. */
  target?: string;
  /** Workflow-style explicit profile selection. */
  profile?: string;
  /** Workflow-style explicit provider selection. */
  provider?: LocalAgentProvider;
  /** Workflow metadata fallback before the first available provider. */
  defaultProvider?: LocalAgentProvider;
  model?: string;
  effort?: string;
}

/**
 * Resolve the executable provider, prompt, and model controls for both direct
 * subagents and workflow agent() calls. Provider policy defaults can be added
 * here later without changing either caller.
 */
export function resolveLocalAgentExecution(
  input: ResolveLocalAgentExecutionInput,
): ResolvedLocalAgentExecution {
  if (input.target !== undefined) {
    const profile = input.profiles.find((candidate) => candidate.name === input.target);
    if (profile) return resolveProfile(profile, input);
    if (!isLocalAgentProvider(input.target)) {
      throw new LocalAgentResolutionError(
        "target_not_found",
        `Unknown subagent profile or provider: ${input.target}`,
      );
    }
    return resolveProvider(input.target, input, "requested");
  }

  if (input.profile) {
    const profile = input.profiles.find((candidate) => candidate.name === input.profile);
    if (!profile) {
      const available = input.profiles.map((candidate) => candidate.name).join(", ");
      throw new LocalAgentResolutionError(
        "profile_not_found",
        `Unknown agent profile: ${input.profile}${available ? `. Available profiles: ${available}` : ""}`,
      );
    }
    return resolveProfile(profile, input);
  }

  if (input.provider) return resolveProvider(input.provider, input, "requested");
  if (input.defaultProvider) return resolveProvider(input.defaultProvider, input, "default");

  const provider = input.availableProviders[0];
  if (!provider) {
    throw new LocalAgentResolutionError("no_provider", "No agent providers are available");
  }
  return resolveProvider(provider, input, "fallback");
}

function resolveProfile(
  profile: LocalAgentProfile,
  input: ResolveLocalAgentExecutionInput,
): ResolvedLocalAgentExecution {
  if (!input.availableProviders.includes(profile.provider)) {
    throw new LocalAgentResolutionError(
      "provider_unavailable",
      `Agent profile ${profile.name} requires unavailable provider ${profile.provider}`,
    );
  }
  return {
    kind: "profile",
    name: profile.name,
    provider: profile.provider,
    model: input.model ?? profile.model,
    effort: input.effort ?? profile.effort,
    prompt: buildProfilePrompt(profile, input.prompt),
    profile,
    profileName: profile.name,
    profileFingerprint: fingerprintProfile(profile),
  };
}

function buildProfilePrompt(profile: LocalAgentProfile, prompt: string): string {
  const instructions = profile.body.trim();
  return instructions ? `${instructions}\n\nTask:\n${prompt}` : prompt;
}

function fingerprintProfile(profile: LocalAgentProfile): string {
  return createHash("sha256")
    .update(JSON.stringify({
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
      body: profile.body,
    }))
    .digest("hex");
}

function resolveProvider(
  provider: LocalAgentProvider,
  input: ResolveLocalAgentExecutionInput,
  source: "requested" | "default" | "fallback",
): ResolvedLocalAgentExecution {
  if (!input.availableProviders.includes(provider)) {
    const label = source === "default" ? "Default provider" : "Provider";
    throw new LocalAgentResolutionError(
      "provider_unavailable",
      `${label} ${provider} is not available`,
    );
  }
  return {
    kind: "provider",
    name: provider,
    provider,
    model: input.model,
    effort: input.effort,
    prompt: input.prompt,
  };
}
