import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

function read(path) {
  return readFileSync(path, "utf8");
}

function write(path, content) {
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
}

function replaceOnce(content, search, replacement, label) {
  if (!content.includes(search)) {
    throw new Error(`Missing expected text for ${label}`);
  }
  return content.replace(search, replacement);
}

function replaceRegex(content, regex, replacement, label) {
  if (!regex.test(content)) {
    throw new Error(`Missing expected pattern for ${label}`);
  }
  regex.lastIndex = 0;
  return content.replace(regex, replacement);
}

// package.json: remove model-provider runtimes. DevSpace remains a pure MCP execution layer.
{
  const path = "package.json";
  const pkg = JSON.parse(read(path));
  pkg.description = "Pure local MCP coding runtime for ChatGPT and other MCP hosts.";
  for (const dependency of [
    "@agentclientprotocol/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
    "@opencode-ai/sdk",
  ]) {
    delete pkg.dependencies[dependency];
  }
  pkg.files = pkg.files.filter((entry) => entry !== "skills");
  pkg.scripts.test = pkg.scripts.test
    .split(" && ")
    .filter((command) => !command.includes("local-agent-"))
    .join(" && ");
  write(path, JSON.stringify(pkg, null, 2));
}

// Remove the local model/subagent runtime completely.
for (const name of readdirSync("src")) {
  if (name.startsWith("local-agent-") && name.endsWith(".ts")) {
    rmSync(join("src", name));
  }
}
rmSync("skills/subagent-delegation", { recursive: true, force: true });

// Config: native is the default host-driven coding surface. Legacy codex mode maps to native.
{
  const path = "src/config.ts";
  let source = read(path);
  source = replaceOnce(
    source,
    'import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";',
    'import { devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";',
    "config user-config import",
  );
  source = replaceOnce(
    source,
    'export type ToolMode = "minimal" | "full" | "codex";',
    'export type ToolMode = "minimal" | "full" | "native";',
    "tool mode type",
  );
  source = replaceOnce(source, "  devspaceAgentsDir: string;\n", "", "devspaceAgentsDir field");
  source = replaceOnce(source, "  subagents: boolean;\n", "", "subagents field");
  source = replaceRegex(
    source,
    /function parseToolMode\(env: NodeJS\.ProcessEnv\): ToolMode \{[\s\S]*?\n\}/,
    `function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {\n  const mode = env.DEVSPACE_TOOL_MODE;\n  if (mode === "minimal" || mode === "full" || mode === "native") return mode;\n  // Backward compatibility: the old "codex" surface was only a tool layout.\n  // It never needs to invoke Codex; native is now the canonical name.\n  if (mode === "codex") return "native";\n  if (mode) throw new Error(\`Invalid DEVSPACE_TOOL_MODE: \${mode}\`);\n\n  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {\n    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";\n  }\n  return "native";\n}`,
    "parseToolMode",
  );
  source = replaceOnce(
    source,
    'function defaultAgentDir(): string {\n  return join(homedir(), ".codex");\n}',
    'function defaultAgentDir(): string {\n  return join(homedir(), ".devspace", "context");\n}',
    "default global instruction directory",
  );
  source = replaceOnce(
    source,
    "    devspaceSkillsDir: devspaceSkillsDir(env),\n    devspaceAgentsDir: devspaceAgentsDir(env),\n    subagents:\n      env.DEVSPACE_SUBAGENTS === undefined\n        ? files.config.subagents === true\n        : parseBoolean(env.DEVSPACE_SUBAGENTS),\n",
    "    devspaceSkillsDir: devspaceSkillsDir(env),\n",
    "subagent config",
  );
  write(path, source);
}

// User config: remove subagent-specific persisted settings and seeded delegation skill.
{
  const path = "src/user-config.ts";
  let source = read(path);
  source = replaceOnce(
    source,
    'import {\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  writeFileSync,\n} from "node:fs";',
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    "user-config fs import",
  );
  source = replaceOnce(source, 'import { dirname, join, resolve } from "node:path";', 'import { join, resolve } from "node:path";', "user-config path import");
  source = replaceOnce(source, "  subagents?: boolean;\n", "", "user subagents field");
  source = replaceRegex(
    source,
    /\nexport function devspaceAgentsDir[\s\S]*?\n\}/,
    "",
    "devspaceAgentsDir function",
  );
  source = replaceRegex(
    source,
    /\nexport function ensureDevspaceDefaultSkills[\s\S]*?(?=\nexport function resolveSubagentsFlag)/,
    "",
    "default subagent skill seeding",
  );
  source = replaceRegex(
    source,
    /\nexport function resolveSubagentsFlag[\s\S]*?\n\}/,
    "",
    "resolveSubagentsFlag",
  );
  write(path, source);
}

// CLI: remove the local-agent command family and provider setup. ChatGPT/MCP host is the agent.
{
  const path = "src/cli.ts";
  let source = read(path);
  source = replaceRegex(
    source,
    /import \{ runLocalAgentProvider \}[\s\S]*?import type \{ LocalAgentRunResult \} from "\.\/local-agent-runtime\.js";\n/,
    "",
    "CLI local-agent imports",
  );
  source = replaceOnce(source, "  ensureDevspaceDefaultSkills,\n", "", "CLI seeded skill import");
  source = replaceOnce(source, "  resolveSubagentsFlag,\n", "", "CLI subagent flag import");
  source = replaceOnce(
    source,
    'type Command = "serve" | "init" | "doctor" | "config" | "agents" | "help" | "version";',
    'type Command = "serve" | "init" | "doctor" | "config" | "help" | "version";',
    "CLI command type",
  );
  source = replaceOnce(source, 'const SUPPORTED_NODE_RANGE = ">=20.12 <27";', 'const SUPPORTED_NODE_RANGE = ">=22.19 <27";', "Node support range");
  source = replaceOnce(
    source,
    '    case "agents":\n      await runAgentsCommand(args);\n      return;\n',
    "",
    "CLI agents switch",
  );
  source = replaceOnce(
    source,
    '  if (command === "init" || command === "doctor" || command === "config" || command === "agents") return command;',
    '  if (command === "init" || command === "doctor" || command === "config") return command;',
    "CLI normalize agents",
  );
  source = replaceOnce(source, "      subagents: resolveSubagentsFlag(files.config),\n", "", "init subagents config");
  source = replaceOnce(source, "    const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];\n", "", "seeded skill paths");
  source = replaceOnce(source, "      ...seededSkillPaths.map((path) => `Default skill: ${path}`),\n", "", "seeded skill output");
  source = replaceOnce(source, "  const { app, close, localAgentProviders } = createServer(config);", "  const { app, close } = createServer(config);", "serve provider destructure");
  source = replaceRegex(
    source,
    /\n    if \(config\.subagents\) \{\n      console\.log\(`subagent providers: \$\{formatLocalAgentProviderAvailabilitySummary\(localAgentProviders\)\}`\);\n    \}/,
    "",
    "serve provider log",
  );
  source = source
    .replace('      "  devspace agents ls       List subagent sessions",\n', "")
    .replace('      "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",\n', "")
    .replace('      "  devspace agents show <id>",\n', "");
  source = replaceRegex(
    source,
    /\nasync function runAgentsCommand[\s\S]*?(?=\nfunction printVersion\(\): void)/,
    "\n",
    "CLI agents implementation",
  );
  write(path, source);
}

// Workspace state no longer carries local model profiles.
{
  const path = "src/workspaces.ts";
  let source = read(path);
  source = replaceRegex(
    source,
    /import \{\n  loadLocalAgentProfiles,[\s\S]*?\} from "\.\/local-agent-profiles\.js";\n/,
    "",
    "workspace local-agent import",
  );
  source = replaceOnce(source, '  agentProfiles: LocalAgentProfile[];\n', "", "workspace agentProfiles field");
  source = replaceOnce(source, '    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);\n', "", "workspace reload profiles");
  source = replaceOnce(source, '      agentProfiles: [],\n', "", "restored workspace profiles");
  source = replaceOnce(source, '      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),\n', "", "new workspace profiles");
  write(path, source);
}

// MCP server: remove subagent metadata and expose a host-driven native CLI-like surface.
{
  const path = "src/server.ts";
  let source = read(path);
  source = replaceOnce(source, 'import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";\n', "", "server profile import");
  source = replaceRegex(
    source,
    /import \{\n  formatLocalAgentProviderAvailabilitySummary,[\s\S]*?\} from "\.\/local-agent-availability\.js";\n/,
    "",
    "server availability import",
  );
  source = replaceOnce(source, '  localAgentProviders: LocalAgentProviderAvailability[];\n', "", "running server providers");
  source = replaceRegex(source, /function formatVisibleAgent[\s\S]*?(?=function resultOutputSchema)/, "", "server agent formatters");
  source = replaceRegex(source, /const workspaceLocalAgentOutputSchema[\s\S]*?(?=const workspaceAvailableAgentsFileOutputSchema)/, "", "server agent schemas");

  source = replaceRegex(
    source,
    /  if \(config\.toolMode === "codex"\) \{[\s\S]*?\n  \}/,
    `  if (config.toolMode === "native") {\n    return \`Use DevSpace as a local coding runtime. Call \${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. The MCP host is the coding agent; DevSpace does not delegate reasoning or coding to another model. Prefer \${toolNames.read}, \${toolNames.grep}, \${toolNames.glob}, and \${toolNames.ls} for efficient inspection. Use apply_patch for precise source edits when convenient. Use exec_command for normal development shell operations, including rm, mv, cp, mkdir, git, package managers, generators, tests, builds, and scripts that modify workspace files; use write_stdin to poll or interact with running processes. Shell commands run with the local user's authority and are not an OS sandbox, so keep destructive actions scoped to the user's requested task. Follow instructions returned by \${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.\${artifactInstruction}\${showChangesInstruction}\`;\n  }`,
    "native server instructions",
  );
  source = source.replaceAll('config.toolMode !== "codex"', 'config.toolMode !== "native"');
  source = source.replaceAll('config.toolMode === "codex"', 'config.toolMode === "native"');
  source = source.replaceAll("registerCodexProcessTools", "registerNativeProcessTools");
  source = source.replace('if (config.toolMode === "full") {', 'if (config.toolMode === "full" || config.toolMode === "native") {');

  source = replaceOnce(
    source,
    '      description:\n        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",',
    '      description: config.toolMode === "native"\n        ? "Run a normal local development shell command from the open workspace, including commands that create, move, rename, or delete workspace files (for example rm, mv, cp, mkdir, git, package managers, generators, tests, and builds). Long-running commands return a sessionId for write_stdin. The shell has the local user\\\'s authority and is not sandboxed."\n        : "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",',
    "native exec description",
  );
  source = replaceOnce(
    source,
    '        description:\n          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",',
    '        description: config.toolMode === "native"\n          ? "Apply a structured patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use it when a patch is the clearest editing method; normal shell file operations are also allowed in native mode. Paths must be relative to the workspace."\n          : "Apply a structured patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Paths must be relative to the workspace.",',
    "native apply_patch description",
  );

  source = replaceOnce(source, '  localAgentProviders: LocalAgentProviderAvailability[],\n', "", "createMcpServer provider parameter");
  source = source
    .replace('        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),\n', "")
    .replace('        agents: z.array(workspaceLocalAgentOutputSchema).optional(),\n', "");
  source = replaceRegex(
    source,
    /      const cardAgentProviders = config\.subagents \? localAgentProviders : \[\];[\s\S]*?(?=      const cardAgentsFiles)/,
    "",
    "workspace card agents",
  );
  source = source
    .replace('      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];\n', "")
    .replace('      const visibleAgents = includeBootstrapContext ? cardAgents : [];\n', "")
    .replace("skills, agent profiles, and diagnostics", "skills and diagnostics")
    .replace("skills, agent profiles, and diagnostics returned for this isolated worktree", "skills and diagnostics returned for this isolated worktree");
  source = replaceRegex(
    source,
    /            visibleAgentProviders\.some\(\(provider\) => provider\.available\)[\s\S]*?            visibleAgents\.length > 0[\s\S]*?              : undefined,\n/,
    "",
    "workspace result agent metadata",
  );
  source = source
    .replace('            agentProviders: cardAgentProviders,\n', "")
    .replace('            agents: cardAgents,\n', "")
    .replace('              agentProviders: cardAgentProviders.length,\n', "")
    .replace('              agents: cardAgents.length,\n', "")
    .replace('                agentProviders: visibleAgentProviders,\n', "")
    .replace('                agents: visibleAgents,\n', "");
  source = replaceRegex(
    source,
    /  const localAgentProviders = config\.subagents[\s\S]*?    : \[\];\n/,
    "",
    "server provider snapshot",
  );
  source = source.replace('          localAgentProviders,\n', "");
  source = source.replace('    localAgentProviders,\n', "");
  source = source.replace('  const { app, config, close, localAgentProviders } = createServer();', '  const { app, config, close } = createServer();');
  source = replaceRegex(
    source,
    /\n    if \(config\.subagents\) \{\n      console\.log\(`subagent providers: \$\{formatLocalAgentProviderAvailabilitySummary\(localAgentProviders\)\}`\);\n    \}/,
    "",
    "server provider log",
  );
  write(path, source);
}

// Tests: preserve behavior coverage while removing model-provider expectations.
{
  const path = "src/cli.test.ts";
  write(path, `import assert from "node:assert/strict";\nimport { execFileSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\n\nconst packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {\n  version: string;\n};\n\nfor (const flag of ["-v", "--version"]) {\n  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {\n    encoding: "utf8",\n    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },\n  }).trim();\n  assert.equal(output, packageJson.version);\n}\n\nconst help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--help"], {\n  encoding: "utf8",\n  env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-help-test" },\n});\nassert.doesNotMatch(help, /devspace agents/);\n`);
}

{
  const path = "src/config.test.ts";
  let source = read(path);
  source = replaceOnce(source, 'import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";', 'import { mkdtempSync, writeFileSync } from "node:fs";', "config test fs import");
  source = replaceOnce(source, 'import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";\n', "", "config test subagent import");
  source = replaceOnce(source, 'assert.equal(loadConfig(baseEnv).toolMode, "minimal");', 'assert.equal(loadConfig(baseEnv).toolMode, "native");', "default native test");
  source = replaceOnce(source, 'assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");', 'assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "native" }).toolMode, "native");\nassert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "native");', "native and legacy codex test");
  source = replaceRegex(
    source,
    /assert\.equal\(loadConfig\(baseEnv\)\.devspaceAgentsDir[\s\S]*?assert\.deepEqual\(ensureDevspaceDefaultSkills\([^\n]*\), \[\]\);\n/,
    "",
    "config subagent tests",
  );
  source = source.replace('    subagents: true,\n', "");
  source = source.replace('assert.equal(fileConfig.subagents, true);\n', "");
  write(path, source);
}

{
  const path = "src/workspaces.test.ts";
  let source = read(path);
  source = replaceRegex(
    source,
    /\n  assert\.deepEqual\(\n    opened\.workspace\.agentProfiles[\s\S]*?\n  \);\n/,
    "\n",
    "workspace profile assertion",
  );
  write(path, source);
}

{
  const path = "src/workspace-conversation.test.ts";
  let source = read(path);
  source = source.replace('  assert.deepEqual(second.workspace.agentProfiles, first.workspace.agentProfiles);\n', "");
  source = replaceRegex(
    source,
    /test\("a failed first context load[\s\S]*?(?=\ntest\("a context-loading failure)/,
    "",
    "conversation failed profile load test",
  );
  source = replaceRegex(
    source,
    /test\("a context-loading failure[\s\S]*?(?=\ntest\("a deleted checkout)/,
    "",
    "conversation profile recovery test",
  );
  write(path, source);
}

{
  const path = "src/server.test.ts";
  let source = read(path);
  source = source.replace(/^.*\.agentProviders\b.*\n/gm, "");
  source = source.replace(/^.*\.agents\b.*\n/gm, "");
  source = source.replace(/(new ProcessSessionManager\(\),\n\s*)\[\],\n\s*\[\],/g, "$1[],");
  source = replaceOnce(source, 'async function fixture(t: TestContext, options: { git?: boolean } = {}): Promise<ServerFixture> {', 'async function fixture(t: TestContext, options: { git?: boolean; toolMode?: "full" | "native" } = {}): Promise<ServerFixture> {', "server fixture options");
  source = replaceOnce(source, '    DEVSPACE_TOOL_MODE: "full",', '    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",', "server fixture tool mode");
  source = replaceOnce(
    source,
    '\ninterface ServerFixture {',
    `\ntest("native mode exposes host-driven CLI tools without subagent metadata", async (t) => {\n  const context = await fixture(t, { toolMode: "native" });\n  const tools = await context.client.listTools();\n  const names = new Set(tools.tools.map((tool) => tool.name));\n\n  for (const name of ["open_workspace", "read", "grep", "glob", "ls", "apply_patch", "exec_command", "write_stdin"]) {\n    assert.equal(names.has(name), true, \`missing native tool: \${name}\`);\n  }\n  for (const name of ["bash", "write", "edit"]) {\n    assert.equal(names.has(name), false, \`unexpected legacy tool: \${name}\`);\n  }\n  const execTool = tools.tools.find((tool) => tool.name === "exec_command");\n  assert.match(execTool?.description ?? "", /rm, mv, cp, mkdir/);\n});\n\ninterface ServerFixture {`,
    "native server surface test",
  );
  write(path, source);
}

// Rewrite project-facing docs around the simplified architecture.
write("README.md", `# DevSpace — Pure MCP Coding Runtime\n\nDevSpace connects ChatGPT or another MCP host directly to a local development workspace. In this fork, **the MCP host is the agent**: DevSpace does not invoke Codex, Claude Code, OpenCode, Cursor, Copilot, or another model behind the scenes.\n\n\`\`\`text\nChatGPT Web / MCP host\n        |\n        | MCP\n        v\n     DevSpace\n        |\n        +-- workspace files\n        +-- search / read\n        +-- apply_patch\n        +-- native shell / long-running processes\n        +-- Git worktrees / change review\n\`\`\`\n\n## Why this fork\n\nThe goal is a small, transparent tool layer for using the reasoning and coding capacity of the MCP host itself. There is no second model invocation and therefore no hidden Codex/Claude subagent usage from DevSpace.\n\n## Native mode\n\n\`native\` is the default tool mode. It exposes:\n\n- \`open_workspace\`\n- \`read\`\n- \`grep\`\n- \`glob\`\n- \`ls\`\n- \`apply_patch\`\n- \`exec_command\`\n- \`write_stdin\`\n\nThe host may use normal development shell commands such as \`rm\`, \`mv\`, \`cp\`, \`mkdir\`, \`git\`, package managers, generators, tests, builds, Docker, and project scripts. \`exec_command\` supports long-running process sessions and \`write_stdin\` can poll or interact with them.\n\nLegacy \`DEVSPACE_TOOL_MODE=codex\` is accepted as an alias for \`native\` so existing setups do not break. \`minimal\` and \`full\` remain available for the older structured/guarded surfaces.\n\n## Security model\n\nFile tools are workspace-scoped, but **the shell is not an OS sandbox**. Commands run with the authority of the local user running DevSpace. A command can access paths outside the workspace if the operating system account can access them. Use strong OAuth protection and expose DevSpace only to MCP clients you trust.\n\nGit worktree mode is useful for isolating project changes, but it is not a security sandbox.\n\n## Local development\n\nRequirements: Node.js \`>=22.19 <27\` and Git.\n\n\`\`\`bash\nnpm ci\nnpm run typecheck\nnpm test\nnpm run build\nnode dist/cli.js init\nnode dist/cli.js serve\n\`\`\`\n\nThe setup flow stores configuration under \`~/.devspace\` and asks for a public HTTPS base URL so ChatGPT can reach the MCP endpoint.\n\nUseful environment variables:\n\n\`\`\`bash\nDEVSPACE_TOOL_MODE=native\nDEVSPACE_ALLOWED_ROOTS=/path/to/projects\nDEVSPACE_PUBLIC_BASE_URL=https://your-tunnel.example.com\nDEVSPACE_WIDGETS=changes\nDEVSPACE_ARTIFACTS=1\n\`\`\`\n\n## Workspace model\n\nCall \`open_workspace\` once for a project and reuse its \`workspaceId\`. Checkout mode operates on the existing directory. Worktree mode creates an isolated Git worktree for parallel or disposable changes. Project \`AGENTS.md\` / \`CLAUDE.md\` instructions and DevSpace skills can still be surfaced to the MCP host.\n\n## What was intentionally removed\n\nThis fork removes local model-provider adapters, agent sessions, agent profiles as execution targets, and the provider SDK dependencies for Codex, Claude Agent SDK, OpenCode, and ACP. DevSpace is intentionally a runtime/tool boundary rather than an agent orchestrator.\n\n## License\n\nMIT. Based on the original DevSpace project by Waishnav.\n`);

write("AGENTS.md", `# DevSpace fork guidance\n\nDevSpace in this fork is a **pure MCP coding runtime**. Keep the architecture simple: the MCP host is the agent and DevSpace provides local tools, workspace state, authentication, process sessions, worktrees, artifacts, and review UI.\n\n## Core rules\n\n1. Do not add model-provider SDKs or hidden agent loops.\n2. Do not delegate coding/reasoning to Codex, Claude, OpenCode, Cursor, Copilot, or another model from inside DevSpace.\n3. Keep the native tool surface CLI-like: normal shell operations are allowed, including file mutations, while clearly documenting that shell execution is not sandboxed.\n4. Preserve workspace IDs, approved roots for structured file tools, OAuth, Git worktrees, process sessions, skills, project instruction files, artifacts, and change review.\n5. Prefer explicit MCP primitives and observable process state over hidden autonomy.\n6. Add or update tests when changing the model-facing tool schema or workspace lifecycle.\n\n## Important files\n\n- \`src/server.ts\` — MCP tools, descriptions, and HTTP server.\n- \`src/process-sessions.ts\` — native/long-running command sessions.\n- \`src/workspaces.ts\` — workspace lifecycle and context.\n- \`src/roots.ts\` — structured file-tool containment.\n- \`src/git-worktrees.ts\` — isolated worktrees.\n- \`src/oauth-provider.ts\` — single-user OAuth approval flow.\n- \`src/ui/\` — MCP app cards.\n\n## Verification\n\nRun \`npm run typecheck\`, \`npm test\`, and \`npm run build\` for code changes. Remember that a Git worktree is change isolation, not an OS security sandbox.\n`);

// Fail the refactor if active source still depends on the removed local-agent implementation.
const remainingSourceRefs = readdirSync("src")
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .flatMap((name) => {
    const content = read(join("src", name));
    const hits = [];
    if (content.includes("local-agent-")) hits.push(`${name}: local-agent import`);
    if (/\bsubagents\b/.test(content)) hits.push(`${name}: subagents`);
    if (/\bagentProfiles\b/.test(content)) hits.push(`${name}: agentProfiles`);
    return hits;
  });
if (remainingSourceRefs.length > 0) {
  throw new Error(`Pure MCP cleanup incomplete:\n${remainingSourceRefs.join("\n")}`);
}

console.log("Pure MCP refactor applied successfully.");
