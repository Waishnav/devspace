export const LOCAL_AGENT_DRIVER_KINDS = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "acp",
] as const;

export const LEGACY_ACP_DRIVER_KINDS = ["cursor", "copilot", "grok"] as const;
export const LOCAL_AGENT_DEFAULT_PROVIDER_IDS = [
  "codex",
  "claude",
  "opencode",
  "pi",
  ...LEGACY_ACP_DRIVER_KINDS,
] as const;

export type LocalAgentDriverKind = typeof LOCAL_AGENT_DRIVER_KINDS[number];

/** User-configured routing identity. Multiple instances may share one driver. */
export type LocalAgentProviderInstanceId = string;

const DRIVER_KINDS = new Set<string>(LOCAL_AGENT_DRIVER_KINDS);
const LEGACY_ACP_DRIVERS = new Set<string>(LEGACY_ACP_DRIVER_KINDS);

export function isLocalAgentDriverKind(value: string): value is LocalAgentDriverKind {
  return DRIVER_KINDS.has(value);
}

export function isLegacyAcpDriverKind(value: string): value is typeof LEGACY_ACP_DRIVER_KINDS[number] {
  return LEGACY_ACP_DRIVERS.has(value);
}

export function defaultDriverForProviderId(value: string): LocalAgentDriverKind | undefined {
  if (isLocalAgentDriverKind(value)) return value;
  if (isLegacyAcpDriverKind(value)) return "acp";
  return undefined;
}
