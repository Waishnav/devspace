// Brand marks, inlined as raw SVG so `currentColor` marks follow the theme.
// Sourced from the GitCMS marketing site; see README for provenance.
const files = import.meta.glob<string>("./*.svg", { query: "?raw", import: "default", eager: true });

export type LogoId = "openai" | "claude" | "grok" | "muse" | "openclaw" | "hermes" | "opencode" | "pi" | "cursor" | "copilot";

export function logoSvg(id: LogoId): string {
  const svg = files[`./${id}.svg`];

  if (!svg) throw new Error(`Unknown logo: ${id}`);
  // Marks with dedicated dark-background artwork ship both; variants.css picks one.
  const dark = files[`./${id}-dark.svg`];

  return dark ? `<span class="lv lv--light">${svg}</span><span class="lv lv--dark">${dark}</span>` : svg;
}

/** Orchestration interfaces: where people talk to the model that delegates. Order drives the animations. */
export const HOSTS: ReadonlyArray<{ name: string; logo: LogoId }> = [
  { name: "Grok Bot", logo: "grok" },
  { name: "ChatGPT", logo: "openai" },
  { name: "Claude", logo: "claude" },
  { name: "Muse", logo: "muse" },
  { name: "OpenClaw", logo: "openclaw" },
  { name: "Hermes", logo: "hermes" },
];

/** Coding harnesses DevSpace can run as subagents. */
export const PROVIDERS: ReadonlyArray<{ id: string; name: string; via: string; logo: LogoId }> = [
  { id: "codex", name: "Codex", via: "app-server", logo: "openai" },
  { id: "claude", name: "Claude Code", via: "Agent SDK", logo: "claude" },
  { id: "opencode", name: "OpenCode", via: "SDK", logo: "opencode" },
  { id: "pi", name: "Pi", via: "embedded SDK", logo: "pi" },
  { id: "cursor", name: "Cursor", via: "ACP", logo: "cursor" },
  { id: "copilot", name: "Copilot", via: "ACP", logo: "copilot" },
  { id: "grok", name: "Grok Build", via: "ACP", logo: "grok" },
];

export const providerLogo = (id: string): LogoId => PROVIDERS.find((p) => p.id === id)?.logo ?? "openai";
