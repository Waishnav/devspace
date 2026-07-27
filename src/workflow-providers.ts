import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

/** Live providers in stable product order for workflow agent() resolution. */
export function resolveWorkflowLiveProviders(): LocalAgentProvider[] {
  const snapshot = getLocalAgentProviderAvailabilitySnapshot();
  const live = new Set(snapshot.filter((row) => row.available).map((row) => row.name));
  return LOCAL_AGENT_PROVIDERS.filter((id) => live.has(id));
}
