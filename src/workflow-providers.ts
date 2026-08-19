import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { ServerConfig } from "./config.js";

/** Live providers in stable product order for workflow agent() resolution. */
export function resolveWorkflowLiveProviders(
  config: Pick<ServerConfig, "agentProviders">,
): LocalAgentProvider[] {
  const snapshot = getLocalAgentProviderAvailabilitySnapshot(
    process.env,
    config.agentProviders,
  );
  const live = new Set(snapshot.filter((row) => row.available).map((row) => row.name));
  return LOCAL_AGENT_PROVIDERS.filter((id) => config.agentProviders.includes(id) && live.has(id));
}
