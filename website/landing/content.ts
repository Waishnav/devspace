// Copy shared by every landing variant, so the three designs differ in
// presentation only and stay truthful to what DevSpace actually ships.

export const INSTALL = "npx @waishnav/devspace init";
export const GITHUB = "https://github.com/Waishnav/devspace";
export const NPM = "https://www.npmjs.com/package/@waishnav/devspace";
export const DOCS = "/docs";

export const HOSTS = ["ChatGPT", "Claude", "Codex", "Claude Code", "OpenCode", "Pi", "Cursor"];

export const PROVIDERS = [
  { id: "codex", name: "Codex", via: "app-server" },
  { id: "claude", name: "Claude Code", via: "Agent SDK" },
  { id: "opencode", name: "OpenCode", via: "SDK" },
  { id: "pi", name: "Pi", via: "embedded SDK" },
  { id: "cursor", name: "Cursor", via: "ACP" },
  { id: "copilot", name: "Copilot", via: "ACP" },
  { id: "grok", name: "Grok Build", via: "ACP" },
];

// The model-per-task matrix people already maintain by hand.
export const MATRIX = [
  { task: "Plan", profile: "codex · xhigh", why: "long-horizon reasoning" },
  { task: "Implement", profile: "claude-implementer", why: "careful multi-file edits" },
  { task: "Explore", profile: "opencode-explorer", why: "cheap, fast discovery" },
  { task: "Review", profile: "copilot-reviewer", why: "a second vendor's eyes" },
  { task: "QA", profile: "codex-qa-tester", why: "drives the browser" },
];

export const PILLARS = [
  {
    key: "harness",
    kicker: "Harness over MCP",
    title: "A coding agent inside ChatGPT and Claude.",
    body: "Open a workspace, read, patch, run tests, and review a diff card — against your real checkout, through a tunnel you own.",
    href: "/docs/connect/mcp-hosts",
  },
  {
    key: "subagents",
    kicker: "Subagents",
    title: "Any harness can call any other.",
    body: "Codex hands implementation to Claude Code. Claude asks Codex for review. Six commands, one daemon, compact XML the model reads directly.",
    href: "/docs/orchestration/subagents",
  },
  {
    key: "workflows",
    kicker: "Dynamic workflows",
    title: "Program the loop, not the next prompt.",
    body: "agent(), parallel(), pipeline(), phase(). A small replayable script that fans out, isolates writers in worktrees, and resumes from the step that failed.",
    href: "/docs/orchestration/dynamic-workflows",
  },
];

export const WORKFLOW_SNIPPET = `export const meta = {
  name: "ship",
  phases: [{ title: "Plan" }, { title: "Build" }, { title: "Verify" }],
};

phase("Plan");
const plan = await agent(\`Plan: \${args.task}\`, { provider: "codex", effort: "xhigh" });

phase("Build");
await agent(\`Implement:\\n\${plan}\`, { profile: "claude-implementer" });

phase("Verify");
const [review, qa] = await parallel([
  () => agent("Review the diff.", { profile: "copilot-reviewer" }),
  () => agent("Test it in the browser.", { profile: "codex-qa-tester" }),
]);

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
    q: "Do I need ChatGPT or a tunnel?",
    a: "Only if you want ChatGPT or Claude to drive it over MCP. Coding agents call the devspace CLI directly: install one skill and no server is needed.",
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
    a: "Dynamic workflows land in v1.1. Further out: environments — a dedicated computer and compute for your agents, so long runs keep going while your laptop sleeps.",
  },
];
