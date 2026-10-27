import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_RUNNING_EXECUTIONS } from "./code-mode-executions.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { isLocalAgentDriverKind } from "./local-agent-provider.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import {
  configureHttpServer,
  createMcpServer,
  createServer,
} from "./server.js";
import type { ToolSurfaceName } from "./tool-surfaces/index.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";
import {
  listActivityWorkspaces,
  listTurnToolCalls,
  listWorkspaceTurns,
  readTurnDiff,
} from "./workspace-activity.js";
import { WorkspaceActivityJournal } from "./workspace-activity-journal.js";
import { WorkspaceActivityStore } from "./workspace-activity-store.js";

const execFileAsync = promisify(execFile);

test("tool surfaces expose the expected host-facing tools", async (t) => {
  const cases: Array<{
    surface: ToolSurfaceName;
    expected: string[];
  }> = [
    {
      surface: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "show_changes"],
    },
    {
      surface: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "show_changes"],
    },
  ];

  for (const { surface, expected } of cases) {
    await t.test(surface, async (nested) => {
      const context = await fixture(nested, { surface, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("experimental Code Mode bootstraps real tools and executes through MCP", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false, git: true });
  const listed = await context.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "cancel_execution", "execute", "open_workspace", "poll_execution", "show_changes",
  ]);

  const opened = await callOpen(context.client, context.project);
  const workspaceId = structuredContent(opened).workspace_id as string;
  const codeMode = structuredContent(opened).code_mode as { tool_signatures: string };
  assert.match(codeMode.tool_signatures, /read\(/);
  assert.match(codeMode.tool_signatures, /apply_patch\(/);
  assert.match(JSON.stringify(opened.content), /declare const tools/);
  assert.doesNotMatch(codeMode.tool_signatures, /workspace_id/);

  await writeFile(join(context.project, "note.txt"), "hello world\n");
  const executed = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: {
      workspace_id: workspaceId,
      code: `const file = await tools.read({ path: "note.txt" });
        const found = await tools.exec_command({ cmd: "git status --short" });
        return { content: file.result.trim(), status: found.result.trim() };`,
    },
  }));
  assert.equal(executed.status, "completed");
  assert.match((executed.value as { status: string }).status, /^\?\? note\.txt/);
  assert.equal((executed.value as { content: string }).content, "hello world");

  const patched = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: {
      workspace_id: workspaceId,
      code: `return await tools.apply_patch({ patch: "*** Begin Patch\\n*** Update File: note.txt\\n@@\\n-hello world\\n+hello code mode\\n*** End Patch" });`,
    },
  }));
  assert.equal(patched.status, "completed");
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "hello code mode\n");
  const reviewed = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));
  assert.match(reviewed.result as string, /Changed 1 file/);
});

test("Code Mode leaves the open_workspace schema unchanged when disabled", async (t) => {
  const context = await fixture(t, { surface: "codex", uiEnabled: false });
  const { tools } = await context.client.listTools();
  const openWorkspace = tools.find((tool) => tool.name === "open_workspace");
  assert.ok(openWorkspace?.outputSchema?.properties);
  assert.equal("code_mode" in openWorkspace.outputSchema.properties, false);
});

test("experimental Code Mode polls a long-running script without restarting it", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspace_id as string;
  const start = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: {
      workspace_id: workspaceId,
      yield_time_ms: 0,
      code: `let s = await tools.exec_command({ cmd: "node -e \\\"setTimeout(() => console.log('done'), 300)\\\"", yield_time_ms: 0 });
        while (s.running) s = await tools.write_stdin({ session_id: s.session_id, yield_time_ms: 1000 });
        return s.exit_code;`,
    },
  }));
  assert.equal(start.running, true);
  assert.equal(typeof start.execution_id, "string");

  const end = structuredContent(await context.client.callTool({
    name: "poll_execution",
    arguments: { workspace_id: workspaceId, execution_id: start.execution_id, yield_time_ms: 5000 },
  }));
  assert.equal(end.status, "completed");
  assert.equal(end.value, 0);
  assert.deepEqual((end.calls as { tool: string }[]).map((call) => call.tool).slice(0, 2), [
    "exec_command", "write_stdin",
  ]);
});

test("experimental Code Mode rejects invalid tool inputs and interrupts runaway scripts", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspace_id as string;
  const invalid = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: { workspace_id: workspaceId, code: 'return await tools.read({ offset: -1 })' },
  }));
  assert.equal(invalid.status, "failed");
  assert.match(invalid.error as string, /path/);

  const start = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: { workspace_id: workspaceId, code: "while (true) {}", yield_time_ms: 0 },
  }));
  assert.equal(start.running, true);
  await context.client.callTool({
    name: "cancel_execution",
    arguments: { workspace_id: workspaceId, execution_id: start.execution_id },
  });
  const cancelled = structuredContent(await context.client.callTool({
    name: "poll_execution",
    arguments: { workspace_id: workspaceId, execution_id: start.execution_id },
  }));
  assert.equal(cancelled.status, "cancelled");
});

// The command appends to `ticks` until stopped; its exec_command call is still awaiting its first result.
const TICKING_SCRIPT = `await tools.exec_command({ cmd: "while true; do echo tick >> ticks; sleep 0.02; done", yield_time_ms: 10000 }); return "unreachable";`;

async function assertStopsGrowing(path: string): Promise<void> {
  const size = (await stat(path)).size;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await stat(path)).size, size, `${path} kept growing after the command was stopped`);
}

test("cancelling Code Mode stops a command whose exec_command call has not returned", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspace_id as string;
  const start = structuredContent(await context.client.callTool({
    name: "execute",
    arguments: { workspace_id: workspaceId, code: TICKING_SCRIPT, yield_time_ms: 0 },
  }));
  await waitForFile(join(context.project, "ticks"));

  const cancelled = structuredContent(await context.client.callTool({
    name: "cancel_execution",
    arguments: { workspace_id: workspaceId, execution_id: start.execution_id },
  }));
  assert.equal(cancelled.status, "cancelled");
  await assertStopsGrowing(join(context.project, "ticks"));
});

test("closing the MCP server stops running Code Mode scripts and their commands", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspace_id as string;
  await context.client.callTool({
    name: "execute",
    arguments: { workspace_id: workspaceId, code: TICKING_SCRIPT, yield_time_ms: 0 },
  });
  await waitForFile(join(context.project, "ticks"));

  await context.close();
  await assertStopsGrowing(join(context.project, "ticks"));
});

test("Code Mode rejects scripts beyond the server-wide running limit", async (t) => {
  const context = await fixture(t, { experimentalCodeMode: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspace_id as string;
  const execute = () => context.client.callTool({
    name: "execute",
    arguments: { workspace_id: workspaceId, code: "while (true) {}", yield_time_ms: 0 },
  });
  const running = [];
  for (let index = 0; index < MAX_RUNNING_EXECUTIONS; index += 1) {
    running.push(structuredContent(await execute()).execution_id as string);
  }

  const rejected = await execute();
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /already running 4 Code Mode scripts.*cancel_execution/);

  await context.client.callTool({
    name: "cancel_execution",
    arguments: { workspace_id: workspaceId, execution_id: running[0] },
  });
  assert.equal(structuredContent(await execute()).status, "running");
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const surface of ["claude", "codex"] as const) {
    await t.test(surface, async (nested) => {
      const context = await fixture(nested, { surface, uiEnabled: false });
      const tools = await context.client.listTools();
      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools bound model-facing yield windows to 12 seconds", async (t) => {
  const context = await fixture(t, { surface: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);
    const yieldSchema = tool?.inputSchema?.properties?.yield_time_ms as {
      maximum?: number;
      description?: string;
    } | undefined;

    assert.equal(yieldSchema?.maximum, 12_000);
    assert.match(yieldSchema?.description ?? "", /maximum 12000/i);
  }
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { surface: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));
  assert.match(shell.result as string, /nested/i);
});

test("read rejects a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { surface: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside secret\n");

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-read"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "outside-link/secret.txt" },
  });
  assert.equal(result.isError, true);
});

test("write rejects a new file through a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { surface: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-write"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "write",
    arguments: {
      workspace_id: workspaceId,
      path: "outside-link/new.txt",
      content: "escaped\n",
    },
  });
  assert.equal(result.isError, true);
  await assert.rejects(access(join(outside, "new.txt")));
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { surface: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("show_changes reviews an unborn repository through the MCP tool surface", async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  await git(context.project, ["init"]);

  const opened = structuredContent(await callOpen(context.client, context.project, "unborn-review"));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");
  assert.deepEqual(opened.review, { available: true });

  await writeFile(join(context.project, "created-after-open.txt"), "new file\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const card = responseCard(review);

  assert.deepEqual(card.files, [
    {
      path: "created-after-open.txt",
      type: "new",
      additions: 1,
      removals: 0,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /new file/,
  );
  await assert.rejects(() => execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: context.project,
  }));
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspace_id, workspaceId);
  assert.equal("workspaceId" in structured, false);
  assert.match(structured.review_ref as string, /^[0-9a-f]{40,64}$/);
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
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.ok(outputProperties && "review_ref" in outputProperties);
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
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));
  const reviewRef = first.review_ref;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).review_ref, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("workspace activity records turns between review checkpoints", async (t) => {
  const context = await fixture(t, { git: true, captureActivity: true });
  const activity = context.activity!;
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "activity-turns"),
  ).workspace_id as string;
  const patch = (from: string, to: string) => context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch: `*** Begin Patch\n*** Update File: README.md\n@@\n-${from}\n+${to}\n*** End Patch`,
    },
  });
  const showChanges = async () => structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  })).review_ref as string;

  await patch("hello", "hello turn one");
  const firstRef = await showChanges();
  await patch("hello turn one", "hello turn two");
  await context.client.callTool({
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "printf activity" },
  });
  const secondRef = await showChanges();
  await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": firstRef },
  } as Parameters<Client["callTool"]>[0]);

  const turns = listWorkspaceTurns(activity, workspaceId);
  assert.deepEqual(
    turns.map(({ sequence, status, reviewRef }) => ({ sequence, status, reviewRef })),
    [
      { sequence: 3, status: "open", reviewRef: undefined },
      { sequence: 2, status: "closed", reviewRef: secondRef },
      { sequence: 1, status: "closed", reviewRef: firstRef },
    ],
  );
  assert.deepEqual(
    listTurnToolCalls(activity, workspaceId, 1)?.map((call) => call.toolName),
    ["open_workspace", "apply_patch", "show_changes"],
  );
  assert.deepEqual(
    listTurnToolCalls(activity, workspaceId, 2)?.map((call) => call.toolName),
    ["apply_patch", "exec_command", "show_changes"],
  );
  assert.equal(listTurnToolCalls(activity, workspaceId, 3)?.[0]?.origin, "card");

  const secondDiff = await readTurnDiff(activity, workspaceId, 2);
  assert.equal(secondDiff?.status, "available");
  if (secondDiff?.status === "available") {
    assert.match(secondDiff.review.patch, /-hello turn one\n\+hello turn two/);
    assert.doesNotMatch(secondDiff.review.patch, /^-hello$/m);
  }
  assert.deepEqual(await readTurnDiff(activity, workspaceId, 3), { status: "open" });

  const pinned = await execFileAsync("git", ["for-each-ref", "--format=%(refname)", "refs/devspace/review"], {
    cwd: context.project,
  });
  for (const ref of [firstRef, secondRef]) assert.match(pinned.stdout, new RegExp(`/checkpoints/${ref}$`, "m"));

  const [listed] = await listActivityWorkspaces(activity);
  assert.equal(listed?.workspaceId, workspaceId);
  assert.equal(listed?.turns, 3);
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agent_providers as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(typeof firstStructured.workspace_id, "string");
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.ok(Array.isArray(firstStructured.agents_files));
  assert.ok(Array.isArray(firstStructured.available_agents_files));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agent_providers));
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skill_diagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.match(firstStructured.instruction as string, /workspace_id/);
  assert.match(repeatedStructured.instruction as string, /workspace_id/);
  assert.doesNotMatch(firstStructured.instruction as string, /workspaceId/);
  assert.doesNotMatch(repeatedStructured.instruction as string, /workspaceId/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace warns about incomplete instruction discovery on initial and reused opens", async (t) => {
  const context = await fixture(t);
  const projects = Array.from({ length: 300 }, (_, index) => `project-${index}`);
  for (const project of projects) {
    await mkdir(join(context.project, project));
    await writeFile(join(context.project, project, "AGENTS.md"), "nested instructions\n");
  }

  const opened = await callOpen(context.client, context.project, "large-workspace");
  const first = structuredContent(opened);
  assert.match(first.instruction as string, /available_agents_files is incomplete/);
  assert.match(responseCard(opened).instruction as string, /ancestor directories/);
  assert.match(textContent(opened), /even when they are not listed/);
  assert.ok((first.agents_files as Array<{ content: string }>).some(
    (file) => file.content === "project instructions\n",
  ));
  const available = first.available_agents_files as Array<{ path: string }>;
  const omitted = projects.find((project) => !available.some(
    (file) => file.path === `${project}/AGENTS.md`,
  ));
  assert.ok(omitted);
  const read = await context.client.callTool({
    name: "read", arguments: { workspace_id: first.workspace_id, path: `${omitted}/AGENTS.md` },
  });
  assert.match(textContent(read), /nested instructions/);

  const repeated = structuredContent(await callOpen(context.client, context.project, "large-workspace"));
  assert.equal(repeated.workspace_id, first.workspace_id);
  assert.match(repeated.instruction as string, /available_agents_files is incomplete/);
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agent_providers, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
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
      instructions: "on-demand",
      providers: [
        { id: "codex", driver: "codex", enabled: true },
        { id: "claude", driver: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agent_providers as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", driver: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(structuredContent(otherSession).agents_files));
  assert.ok(Array.isArray(structuredContent(unscoped).agents_files));
});

test("HTTP cached workspaceId arguments preserve canonical schemas and validation", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "devspace-cached-arguments-test-");
  await writeFile(join(root, "note.txt"), "cached argument regression\n");
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace", arguments: { path: root },
  });
  const workspaceId = (await opened.json()).result.structuredContent.workspace_id as string;
  assert.equal(typeof workspaceId, "string");

  for (const argumentsValue of [
    { workspaceId, path: "note.txt" },
    { workspaceId, workspace_id: workspaceId, path: "note.txt" },
    { workspace_id: workspaceId, path: "note.txt" },
  ]) {
    const response = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
      name: "read", arguments: argumentsValue,
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.notEqual(body.result?.isError, true, JSON.stringify(body));
    assert.match(JSON.stringify(body.result), /cached argument regression/);
  }

  const conflict = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "read", arguments: { workspaceId, workspace_id: "different", path: "note.txt" },
  });
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error.code, -32602);

  for (const workspaceId of [null, 42, {}, []]) {
    const invalid = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
      name: "read", arguments: { workspaceId, path: "note.txt" },
    });
    const body = await invalid.json();
    assert.ok(body.error || body.result?.isError, JSON.stringify(body));
    assert.notEqual(invalid.status, 500);
  }

  const unauthorized = await postModernMcp(localBaseUrl, undefined, "tools/call", {
    name: "read", arguments: { workspaceId, workspace_id: "different", path: "note.txt" },
  });
  assert.equal(unauthorized.status, 401);
  const outside = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "read", arguments: { workspaceId, path: "../outside.txt" },
  });
  assert.equal((await outside.json()).result.isError, true);

  const listed = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  const tools = (await listed.json()).result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read?.inputSchema.properties?.workspace_id);
  assert.equal(read?.inputSchema.properties?.workspaceId, undefined);
});

test("HTTP conflicting workspace aliases preserve request IDs and notification semantics", async (t) => {
  const { localBaseUrl, accessToken } = await httpServerFixture(t, "devspace-cached-id-test-");
  for (const id of ["cached-request", 37, null, undefined]) {
    await t.test(id === undefined ? "notification" : `request ID ${JSON.stringify(id)}`, async () => {
      const response = await fetch(`${localBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "read",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "tools/call",
          params: { name: "read", arguments: { workspaceId: "old", workspace_id: "new", path: "note.txt" } },
        }),
      });
      if (id === undefined) {
        assert.equal(response.status, 202);
        assert.equal(await response.text(), "");
      } else {
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error.code, -32602);
        assert.equal(body.id, id);
      }
    });
  }
});

test("HTTP endpoint picks the tool surface from the OAuth client", async (t) => {
  const { localBaseUrl, issueAccessToken } = await httpServerFixture(
    t,
    "devspace-surface-http-test-",
  );

  const surfaceFor = async (clientName: string) => {
    const token = await issueAccessToken(clientName);
    const [listed, discovered] = await Promise.all([
      postModernMcp(localBaseUrl, token, "tools/list", {}),
      postModernMcp(localBaseUrl, token, "server/discover", {}),
    ]);
    const tools = (await listed.json() as { result: { tools: Array<{ name: string }> } })
      .result.tools.map((tool) => tool.name);
    const { instructions } = (await discovered.json() as { result: { instructions: string } }).result;
    return { tools, instructions };
  };

  const chatgpt = await surfaceFor("ChatGPT");
  assert.ok(chatgpt.tools.includes("apply_patch"));
  assert.ok(!chatgpt.tools.includes("edit"));
  assert.ok(!chatgpt.instructions.includes("available_agents_files"));

  const claude = await surfaceFor("Claude");
  assert.ok(claude.tools.includes("edit") && claude.tools.includes("bash"));
  assert.ok(!claude.tools.includes("apply_patch"));
  assert.ok(claude.instructions.includes("available_agents_files"));

  const unknown = await surfaceFor("Some other host");
  assert.ok(unknown.tools.includes("bash") && !unknown.tools.includes("apply_patch"));
});

test("HTTP endpoint honours an explicit tools.mode over host detection", async (t) => {
  const { localBaseUrl, issueAccessToken } = await httpServerFixture(
    t,
    "devspace-surface-override-test-",
    false,
    { tools: { mode: "claude" } },
  );
  const listed = await postModernMcp(localBaseUrl, await issueAccessToken("ChatGPT"), "tools/list", {});
  const tools = (await listed.json() as { result: { tools: Array<{ name: string }> } })
    .result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("edit") && !tools.includes("apply_patch"));
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.equal(listed.headers.get("connection"), "keep-alive");
  assert.match(listed.headers.get("keep-alive") ?? "", /timeout=300/);
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("aborting one MCP request does not poison the next stateless request", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-aborted-http-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "aborted-http-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const controller = new AbortController();
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        // The command holds until the test releases it, so it cannot finish before the abort.
        cmd: "node -e \"const fs=require('node:fs');fs.writeFileSync('started','');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);fs.writeFileSync('finished','')}},20)\"",
        yield_time_ms: 10_000,
      },
    },
    { signal: controller.signal },
  );
  await waitForFile(join(root, "started"));
  controller.abort();
  await assert.rejects(toolCall, /abort/i);
  await writeFile(join(root, "release"), "");

  const listed = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  assert.equal(listed.status, 200, await listed.clone().text());
  await listed.text();
  await waitForFile(join(root, "finished"));
});

test("experimental Code Mode executes over stateless HTTP MCP requests", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-codemode-http-test-",
    true,
  );
  await writeFile(join(root, "note.txt"), "through HTTP\n");

  const listed = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  const inventory = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
  assert.deepEqual(inventory.result?.tools?.map((tool) => tool.name).sort(), [
    "cancel_execution", "execute", "open_workspace", "poll_execution", "show_changes",
  ]);

  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
  });
  const response = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string; code_mode?: { tool_signatures: string } } };
  };
  const workspaceId = response.result?.structuredContent?.workspace_id;
  assert.ok(workspaceId);
  assert.match(response.result?.structuredContent?.code_mode?.tool_signatures ?? "", /tools/);

  const call = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "execute",
    arguments: {
      workspace_id: workspaceId,
      code: 'return (await tools.read({ path: "note.txt" })).result.trim()',
    },
  });
  assert.equal(call.status, 200, await call.clone().text());
  const result = await call.json() as {
    result?: { structuredContent?: { status?: string; value?: string } };
  };
  assert.equal(result.result?.structuredContent?.status, "completed");
  assert.equal(result.result?.structuredContent?.value, "through HTTP");
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 12_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

interface ServerFixture {
  client: Client;
  project: string;
  close: () => Promise<void>;
  activity?: WorkspaceActivityStore;
}

function schemaPropertyPaths(
  schema: unknown,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
  };
  const paths = Object.entries(record.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });
  if (record.items) paths.push(...schemaPropertyPaths(record.items, `${prefix}[]`));
  for (const variant of [record.anyOf, record.oneOf, record.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }
  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  issueAccessToken: (clientName: string) => Promise<string>;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
  experimentalCodeMode = false,
  extraConfig: { tools?: { mode: ToolSurfaceName } } = {},
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = { ...loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
    ...extraConfig,
  })), experimentalCodeMode };
  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  configureHttpServer(httpServer);

  t.after(async () => {
    await shutdownHttpServer(httpServer, running.close);
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const issueAccessToken = (clientName: string) => issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
    clientName,
  );
  // Named as ChatGPT so HTTP tests get the Codex surface; unknown hosts get Claude tools.
  const accessToken = await issueAccessToken("ChatGPT");
  return { root, localBaseUrl, accessToken, issueAccessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    surface?: ToolSurfaceName;
    uiEnabled?: boolean;
    experimentalCodeMode?: boolean;
    captureActivity?: boolean;
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
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
    experimentalCodeMode: options.experimentalCodeMode ?? loadedConfig.experimentalCodeMode,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => {
            if (!isLocalAgentDriverKind(provider.name)) {
              throw new Error(`Test provider instance requires explicit config: ${provider.name}`);
            }
            return { id: provider.name, driver: provider.name, enabled: true };
          }),
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
  const activity = options.captureActivity
    ? new WorkspaceActivityStore(stateDir)
    : undefined;
  const activityJournal = activity ? new WorkspaceActivityJournal(activity) : undefined;
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    options.surface ?? "codex",
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    undefined,
    activityJournal,
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
    activity?.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, close, ...(activity ? { activity } : {}) };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
  clientName: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    signal: options.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
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

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok(Array.isArray(result.content));
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
