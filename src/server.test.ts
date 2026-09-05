import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "show_changes"],
    },
    {
      mode: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "show_changes"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspaceId, workspaceId);
  assert.match(structured.reviewRef as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspaceId" in outputProperties);
  assert.ok(outputProperties && "reviewRef" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  const reviewRef = first.reviewRef;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).reviewRef, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace returns scoped model context and keeps UI state in card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const nestedDir = join(context.project, "src");
  const skillDir = join(context.project, ".agents", "skills", "project-skill");
  await mkdir(nestedDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(nestedDir, "AGENTS.md"), "nested instructions\n");
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: project-skill",
    "description: Project-only workflow.",
    "---",
    "",
    "# Project Skill",
  ].join("\n"));

  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  assert.equal(outputProperties && "skillDiagnostics" in outputProperties, false);
  assert.equal(outputProperties && "review" in outputProperties, false);
  assert.equal(outputProperties && "instruction" in outputProperties, false);
  const agentsSchema = outputProperties?.agents as {
    properties?: Record<string, unknown>;
  } | undefined;
  const providerSchema = agentsSchema?.properties?.providers as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  const instructions = firstStructured.instructions as Record<string, unknown>;
  assert.ok(Array.isArray(instructions.global));
  const projectInstructions = instructions.project as Record<string, unknown>;
  assert.equal(
    (projectInstructions.loaded as Array<Record<string, unknown>>)[0]?.path,
    "AGENTS.md",
  );
  assert.equal(
    (projectInstructions.available as Array<Record<string, unknown>>)[0]?.path,
    "src/AGENTS.md",
  );
  const skills = firstStructured.skills as Record<string, unknown>;
  const projectSkill = (skills.project as Array<Record<string, unknown>>)
    .find((skill) => skill.name === "project-skill");
  assert.equal(projectSkill?.path, ".agents/skills/project-skill/SKILL.md");
  assert.equal(projectSkill?.filePath, undefined);
  const agents = firstStructured.agents as Record<string, unknown>;
  assert.equal(
    (agents.providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (agents.providers as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.equal(firstStructured.skillDiagnostics, undefined);
  assert.equal(firstStructured.review, undefined);
  assert.equal(firstStructured.instruction, undefined);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.instructions, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agents, undefined);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal((card.review as { available: boolean }).available, false);
  assert.ok(Array.isArray(card.skills));
});

test("open_workspace re-emits changed project resources without repeating global context", async (t) => {
  const context = await fixture(t);
  const nestedDir = join(context.project, "src");
  const skillDir = join(context.project, ".agents", "skills", "project-skill");
  await mkdir(nestedDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  const nestedFile = join(nestedDir, "AGENTS.md");
  const skillFile = join(skillDir, "SKILL.md");
  const skillHeader = [
    "---",
    "name: project-skill",
    "description: Project-only workflow.",
    "---",
    "",
  ];
  await writeFile(nestedFile, "nested instructions v1\n");
  await writeFile(
    skillFile,
    [...skillHeader, "# Version one"].join("\n"),
  );
  await callOpen(context.client, context.project, "chat-1");
  await writeFile(nestedFile, "nested instructions v2\n");
  await writeFile(skillFile, [...skillHeader, "# Version two"].join("\n"));

  const reopened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const instructions = reopened.instructions as Record<string, unknown>;
  assert.equal(instructions.global, undefined);
  const project = instructions.project as Record<string, unknown>;
  assert.equal(
    (project.available as Array<Record<string, unknown>>)[0]?.path,
    "src/AGENTS.md",
  );
  const skills = reopened.skills as Record<string, unknown>;
  assert.equal(skills.global, undefined);
  assert.equal(
    (skills.project as Array<Record<string, unknown>>)[0]?.path,
    ".agents/skills/project-skill/SKILL.md",
  );
  assert.equal(reopened.agents, undefined);
});

test("a conversation reuses global context when opening another project", async (t) => {
  const context = await fixture(t);
  const otherProject = join(context.project, "..", "other-project");
  await mkdir(otherProject, { recursive: true });
  await writeFile(join(otherProject, "AGENTS.md"), "other project instructions\n");

  await callOpen(context.client, context.project, "chat-1");
  const opened = structuredContent(await callOpen(context.client, otherProject, "chat-1"));
  const instructions = opened.instructions as Record<string, unknown>;
  assert.equal(instructions.global, undefined);
  assert.ok(instructions.project);
  const agents = opened.agents as Record<string, unknown>;
  assert.equal(agents.providers, undefined);
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const unavailableAgents = unavailable.agents as Record<string, unknown>;
  assert.deepEqual(unavailableAgents.providers, []);
  const unavailableProfiles = unavailableAgents.profiles as Record<string, unknown>;
  assert.deepEqual(unavailableProfiles.project, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const usableAgents = usable.agents as Record<string, unknown>;
  assert.equal(usable.instructions, undefined);
  assert.equal(usable.skills, undefined);
  assert.equal(
    (usableAgents.providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  const usableProfiles = usableAgents.profiles as Record<string, unknown>;
  assert.equal(
    (usableProfiles.project as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const agents = opened.agents as Record<string, unknown>;
  assert.deepEqual(
    (agents.providers as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspaceId, structuredContent(first).workspaceId);
  assert.equal(structuredContent(repeated).instructions, undefined);
  assert.notEqual(structuredContent(otherSession).workspaceId, structuredContent(first).workspaceId);
  assert.notEqual(structuredContent(unscoped).workspaceId, structuredContent(first).workspaceId);
  assert.ok(structuredContent(otherSession).instructions);
  assert.ok(structuredContent(unscoped).instructions);
});

test("open_workspace reuses unchanged context when switching to worktree mode", async (t) => {
  const context = await fixture(t, { git: true });
  await git(context.project, ["config", "core.autocrlf", "true"]);
  const checkout = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const worktree = structuredContent(
    await callOpen(context.client, context.project, "chat-1", "worktree"),
  );

  assert.notEqual(worktree.workspaceId, checkout.workspaceId);
  assert.equal(worktree.mode, "worktree");
  assert.equal(worktree.instructions, undefined);
  assert.equal(worktree.skills, undefined);
  assert.equal(worktree.agents, undefined);
});

interface ServerFixture {
  client: Client;
  project: string;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: { enabled: options.localAgentProviders !== undefined, providers: [] },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
