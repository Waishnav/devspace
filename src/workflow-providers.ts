import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { ServerConfig } from "./config.js";

/** Live providers in stable product order for workflow agent() resolution. */
export function resolveWorkflowLiveProviders(
  config: Pick<ServerConfig, "subagents">,
): LocalAgentProvider[] {
  if (!config.subagents.enabled) return [];
  const enabled = config.subagents.providers
    .filter((provider) => provider.enabled)
    .map((provider) => provider.id);
  const snapshot = getLocalAgentProviderAvailabilitySnapshot(process.env);
  const live = new Set(snapshot.filter((row) => row.available).map((row) => row.name));
  return LOCAL_AGENT_PROVIDERS.filter((id) => enabled.includes(id) && live.has(id));
}
