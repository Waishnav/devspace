import type { LocalAgentProvider } from "./local-agent-profiles.js";

export interface LocalAgentProviderCapabilities {
  structuredOutput: "native" | "prompt";
  resumableSessions: boolean;
  cancellation: "signal" | "process";
  supportsWorkspaceIsolation: boolean;
}

export const LOCAL_AGENT_PROVIDER_CAPABILITIES = {
  codex: {
    structuredOutput: "native",
    resumableSessions: true,
    cancellation: "signal",
    supportsWorkspaceIsolation: true,
  },
  claude: {
    structuredOutput: "native",
    resumableSessions: true,
    cancellation: "signal",
    supportsWorkspaceIsolation: true,
  },
  opencode: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
  },
  pi: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
  },
  cursor: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
  },
  copilot: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
  },
} as const satisfies Record<LocalAgentProvider, LocalAgentProviderCapabilities>;

export function supportsNativeStructuredOutput(provider: LocalAgentProvider): boolean {
  return LOCAL_AGENT_PROVIDER_CAPABILITIES[provider].structuredOutput === "native";
}
