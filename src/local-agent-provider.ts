export const LOCAL_AGENT_DRIVER_KINDS = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
  "grok",
] as const;

export type LocalAgentDriverKind = typeof LOCAL_AGENT_DRIVER_KINDS[number];

/** User-configured routing identity. Multiple instances may share one driver. */
export type LocalAgentProviderInstanceId = string;

const DRIVER_KINDS = new Set<string>(LOCAL_AGENT_DRIVER_KINDS);

export function isLocalAgentDriverKind(value: string): value is LocalAgentDriverKind {
  return DRIVER_KINDS.has(value);
}
