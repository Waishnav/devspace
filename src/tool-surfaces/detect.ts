import type { ToolSurfaceName } from "./types.js";

/** What an MCP host tells us about itself; every field is optional. */
export interface HostHints {
  /** `client_name` the host registered through OAuth dynamic client registration. */
  clientName?: string;
  /** `redirect_uris` the host registered. */
  redirectUris?: readonly string[];
  userAgent?: string;
}

export const DEFAULT_TOOL_SURFACE: ToolSurfaceName = "claude";

interface HostSignature {
  surface: ToolSurfaceName;
  clientName: RegExp;
  redirectDomains: readonly string[];
  userAgent: RegExp;
}

const HOST_SIGNATURES: readonly HostSignature[] = [
  {
    surface: "codex",
    clientName: /chatgpt|openai/i,
    redirectDomains: ["chatgpt.com", "openai.com"],
    userAgent: /openai|chatgpt/i,
  },
  {
    surface: "claude",
    clientName: /claude|anthropic/i,
    redirectDomains: ["claude.ai", "claude.com", "anthropic.com"],
    userAgent: /claude|anthropic/i,
  },
];

/**
 * Pick the tool surface a host is trained on.
 *
 * The registered OAuth client identifies a connector and does not change between
 * requests, so it decides first (name, then redirect host). The User-Agent only
 * decides when the client says nothing. Unknown hosts get the Claude surface:
 * plain edit/write/bash tools need no host-specific training.
 */
export function detectToolSurface(hints: HostHints): ToolSurfaceName {
  const { clientName, redirectUris = [], userAgent } = hints;
  const match = (test: (signature: HostSignature) => boolean) =>
    HOST_SIGNATURES.find(test)?.surface;

  return (
    match((s) => clientName !== undefined && s.clientName.test(clientName))
    ?? match((s) => redirectUris.some((uri) => redirectDomainMatches(uri, s.redirectDomains)))
    ?? match((s) => userAgent !== undefined && s.userAgent.test(userAgent))
    ?? DEFAULT_TOOL_SURFACE
  );
}

function redirectDomainMatches(uri: string, domains: readonly string[]): boolean {
  const hostname = URL.parse(uri)?.hostname;
  if (!hostname) return false;
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
