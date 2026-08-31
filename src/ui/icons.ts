import {
  Bot,
  Blocks,
  ChevronDown,
  CircleAlert,
  Cpu,
  FileDiff,
  FileCheck2,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  createElement,
  type IconNode,
} from "lucide";

export const toolIcons = {
  agents: Bot,
  base: GitCommitHorizontal,
  chevronDown: ChevronDown,
  diff: FileDiff,
  folderOpen: FolderOpen,
  gitBranch: GitBranch,
  instructions: FileText,
  instructionAvailable: FileText,
  instructionLoaded: FileCheck2,
  providers: Cpu,
  skills: Blocks,
  sourceCheckout: FolderGit2,
  warning: CircleAlert,
} as const satisfies Record<string, IconNode>;

export type ToolIcon = IconNode;

const providerLogos = {
  claude: {
    light: new URL("./assets/provider-logos/claude.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/claude.svg", import.meta.url).href,
  },
  codex: {
    light: new URL("./assets/provider-logos/openai-light.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/openai-dark.svg", import.meta.url).href,
  },
  copilot: {
    light: new URL("./assets/provider-logos/copilot-light.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/copilot-dark.svg", import.meta.url).href,
  },
  cursor: {
    light: new URL("./assets/provider-logos/cursor-light.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/cursor-dark.svg", import.meta.url).href,
  },
  opencode: {
    light: new URL("./assets/provider-logos/opencode-light.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/opencode-dark.svg", import.meta.url).href,
  },
  pi: {
    light: new URL("./assets/provider-logos/pi-on-light.svg", import.meta.url).href,
    dark: new URL("./assets/provider-logos/pi-on-dark.svg", import.meta.url).href,
  },
} as const;

export type ProviderLogoTheme = "light" | "dark";

export function getProviderLogo(
  name: string,
  theme: ProviderLogoTheme = "dark",
): string | undefined {
  const normalizedName = name.trim().toLowerCase() as keyof typeof providerLogos;
  return providerLogos[normalizedName]?.[theme];
}

export function renderIcon(icon: ToolIcon, className = "icon-svg"): SVGElement {
  return createElement(icon, {
    class: className,
    "aria-hidden": "true",
  });
}
