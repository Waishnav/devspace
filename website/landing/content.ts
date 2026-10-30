// Copy shared by every landing variant, so the three designs differ in
// presentation only and stay truthful to what DevSpace actually ships.

// The first method is the server-rendered default; the page switches to the visitor's OS on load.
export const INSTALL_METHODS = [
  { id: "unix", label: "macOS / Linux", command: "curl -fsSL https://devspace.run/install | sh" },
  { id: "windows", label: "Windows", command: 'powershell -c "irm https://devspace.run/install.ps1 | iex"' },
  { id: "npm", label: "npm", command: "npm install -g @waishnav/devspace" },
] as const;

export const INSTALL = INSTALL_METHODS[0].command;
export const GITHUB = "https://github.com/Waishnav/devspace";
export const NPM = "https://www.npmjs.com/package/@waishnav/devspace";
export const DOCS = "/docs";

import type { LogoId } from "../logos";

export { HOSTS, PROVIDERS } from "../logos";

// The model-per-task matrix people already maintain by hand.
export const MATRIX: ReadonlyArray<{ task: string; profile: string; why: string; logo: LogoId }> = [
  { task: "Plan", profile: "codex/gpt-6-astra-xhigh", why: "long-horizon reasoning", logo: "openai" },
  { task: "Implement", profile: "claude/opus-5.5-medium", why: "careful multi-file edits", logo: "claude" },
  { task: "Explore", profile: "opencode/deepseek-v4.1-flash", why: "cheap, fast discovery", logo: "opencode" },
  { task: "Review", profile: "pi/fable-5.1-high", why: "a second vendor's eyes", logo: "pi" },
  { task: "QA", profile: "codex/gpt-6-sol-medium", why: "drives the browser", logo: "openai" },
];

export const PILLARS = [
  {
    key: "harness",
    kicker: "Harness over MCP",
    title: "A coding harness inside your chat app.",
    body: "ChatGPT, Claude, Grok Bot, OpenClaw, Hermes — open a workspace, read, patch, run tests, and review a diff card against your real checkout, through a tunnel you own.",
    href: "/docs/connect/mcp-hosts",
  },
  {
    key: "subagents",
    kicker: "Subagents",
    title: "Any harness can call any other.",
    body: "Codex hands implementation to Claude Code. Claude asks Codex for review. One CLI, one daemon, compact XML the model reads directly — and worktrees so parallel writers never collide.",
    href: "/docs/orchestration/subagents",
  },
  {
    key: "workflows",
    kicker: "Dynamic workflows · experimental",
    title: "Program the loop, not the next prompt.",
    body: "agent(), parallel(), pipeline(), phase(). A small replayable script that fans out, isolates writers in worktrees, and resumes read-only runs from the step that failed.",
    href: "/docs/orchestration/dynamic-workflows",
  },
];

export const WORKFLOW_SNIPPET = `export const meta = { name: "ship" };

const plan = await phase("Plan", (agent) =>
  agent(\`Plan: \${args.task}\`, {
    target: "codex", model: "gpt-6-astra", effort: "xhigh",
  }));

await phase("Build", (agent) =>
  agent(\`Implement:\\n\${plan}\`, {
    target: "claude", model: "opus-5.5", effort: "medium",
    writeMode: "allowed",
  }));

const [review, qa] = await phase("Verify", (agent) =>
  parallel([
    { target: "pi", model: "fable-5.1", brief: "Review the diff." },
    { target: "codex", model: "gpt-6-sol", brief: "Test it in the browser." },
  ], ({ brief, ...options }) => agent(brief, options)));

return { review, qa };`;

export const FAQ = [
  {
    q: "Is DevSpace another coding agent?",
    a: "No. It is the layer between agents. Your harness stays the orchestrator; DevSpace gives it workspaces, subagents, and workflows, and never runs a hidden agent loop of its own.",
  },
  {
    q: "Which agents can it delegate to?",
    a: "Codex, Claude Code, OpenCode, Pi, Cursor, Copilot, and Grok Build — integrated natively through their SDKs, app-server, or ACP. It uses the CLIs and logins you already have.",
  },
  {
    q: "Where can I orchestrate from?",
    a: "Any MCP host with remote connectors — ChatGPT and Claude, or MCP-capable Grok Bot, OpenClaw, Hermes, and Muse setups — through a tunnel you own. Coding agents like Codex and Claude Code orchestrate too, straight from their shell.",
  },
  {
    q: "Do I need a tunnel?",
    a: "Only if you want a chat app to drive it over MCP. Coding agents call the devspace CLI directly: install one skill and no server is needed.",
  },
  {
    q: "Does my code leave my machine?",
    a: "Not to DevSpace — there is no DevSpace service. Agents run locally with your credentials. What each provider sees follows that provider's own terms.",
  },
  {
    q: "What does it cost?",
    a: "DevSpace is free and MIT-licensed. You bring the subscriptions you already pay for.",
  },
  {
    q: "What is coming next?",
    a: "Dynamic workflows ship in v1.1 as an experiment behind DEVSPACE_EXPERIMENTAL_WORKFLOWS=1. Further out: environments — a dedicated computer and compute for your agents, so long runs keep going while your laptop sleeps.",
  },
];
