import { defineConfig } from "blume";

export default defineConfig({
  title: "DevSpace",
  description:
    "The agent-agnostic orchestration layer for coding agents. Delegate to Codex, Claude Code, OpenCode, Cursor, and more as subagents, and program multi-agent loops as dynamic workflows.",
  logo: { text: "devspace", href: "/" },
  // Landing pages live at the site root; generated docs mount under /docs.
  basePath: "/docs",
  github: { owner: "Waishnav", repo: "devspace", dir: "website" },
  theme: {
    accent: { light: "#161616", dark: "#e8e8e3" },
    background: { light: "#f7f7f5", dark: "#0c0c0c" },
    radius: "sm",
    mode: "system",
    fonts: {
      display: "inter-tight",
      body: "inter",
      mono: "jetbrains-mono",
    },
  },
  navigation: {
    sidebar: { display: "flat" },
  },
  markdown: {
    code: { theme: { light: "github-light", dark: "github-dark" } },
  },
  deployment: { site: "https://devspace.run" },
});
