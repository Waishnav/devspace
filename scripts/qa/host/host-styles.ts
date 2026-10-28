import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

// ext-apps' package root re-exports its spec types extensionlessly, which NodeNext cannot follow.
type HostContext = NonNullable<NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]>;

type McpUiTheme = NonNullable<HostContext["theme"]>;

type McpUiHostStyles = NonNullable<HostContext["styles"]>;

// Representative host palettes using the spec's style variable names. Real
// hosts send their own values; these exist so cards are judged against a
// themed host rather than their built-in fallbacks.
const palettes: Record<McpUiTheme, Record<string, string>> = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f4f4f2",
    "--color-background-tertiary": "#e9e9e6",
    "--color-text-primary": "#1d1d1b",
    "--color-text-secondary": "#55554f",
    "--color-text-tertiary": "#8a8a83",
    "--color-text-danger": "#b42318",
    "--color-text-success": "#1f7a3a",
    "--color-text-warning": "#9a6700",
    "--color-border-primary": "#dcdcd6",
  },
  dark: {
    "--color-background-primary": "#181818",
    "--color-background-secondary": "#212121",
    "--color-background-tertiary": "#2c2c2c",
    "--color-text-primary": "#f2f2f0",
    "--color-text-secondary": "#b8b8b2",
    "--color-text-tertiary": "#8a8a83",
    "--color-text-danger": "#f87171",
    "--color-text-success": "#4ade80",
    "--color-text-warning": "#fbbf24",
    "--color-border-primary": "#3a3a37",
  },
};

export function hostStyles(theme: McpUiTheme): McpUiHostStyles {
  return {
    // SAFETY: The surrounding checks or construction already match this type.
    variables: {
      ...palettes[theme],
      "--font-sans": "ui-sans-serif, system-ui, sans-serif",
      "--font-mono": "ui-monospace, SFMono-Regular, monospace",
    } as McpUiHostStyles["variables"],
  };
}
