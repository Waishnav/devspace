import type { LocalAgentProvider } from "./local-agent-profiles.js";

export function supportsNativeStructuredOutput(provider: LocalAgentProvider): boolean {
  // The daemon contract currently carries text prompts and responses. Workflow
  // schemas therefore use provider-independent prompt repair until structured
  // output becomes a first-class daemon capability.
  return false;
}
