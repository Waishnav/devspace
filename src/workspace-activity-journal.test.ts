import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceActivityJournal } from "./workspace-activity-journal.js";
import { WorkspaceActivityStore } from "./workspace-activity-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const REVIEW_REF = "a".repeat(40);

test("tool calls belong to the open turn until a model show_changes closes it", async (t) => {
  const { journal, activity } = await journalFixture(t, ["ws_turns"]);

  await call(journal, "read", { workspace_id: "ws_turns", path: "README.md" });
  await call(journal, "show_changes", { workspace_id: "ws_turns" }, {
    result: { structuredContent: { workspace_id: "ws_turns", review_ref: REVIEW_REF } },
  });
  await call(journal, "exec_command", { workspace_id: "ws_turns", cmd: "ls" });

  const [second, first] = activity.listTurns("ws_turns");
  assert.deepEqual(
    { sequence: first?.sequence, status: first?.status, reviewRef: first?.reviewRef, calls: first?.toolCalls },
    { sequence: 1, status: "closed", reviewRef: REVIEW_REF, calls: 2 },
  );
  assert.deepEqual(
    { sequence: second?.sequence, status: second?.status, calls: second?.toolCalls },
    { sequence: 2, status: "open", calls: 1 },
  );
  assert.deepEqual(activity.listToolCalls(first!.id).map((entry) => entry.toolName), ["read", "show_changes"]);
});

test("card replays are recorded without closing the turn", async (t) => {
  const { journal, activity } = await journalFixture(t, ["ws_card"]);

  await call(journal, "show_changes", { workspace_id: "ws_card" }, {
    meta: { "devspace/reviewRef": REVIEW_REF },
    result: { structuredContent: { workspace_id: "ws_card", review_ref: REVIEW_REF } },
  });

  const [turn] = activity.listTurns("ws_card");
  assert.equal(turn?.status, "open");
  assert.equal(activity.listToolCalls(turn!.id)[0]?.origin, "card");
});

test("open_workspace is recorded once its workspace exists, and failed opens leave nothing", async (t) => {
  const { journal, activity, workspaces } = await journalFixture(t, []);

  await assert.rejects(call(journal, "open_workspace", { path: "/outside" }, {
    error: new Error("Path is outside allowed roots"),
  }));
  await call(journal, "open_workspace", { path: "/tmp/project" }, {
    meta: { "openai/session": "conversation-1" },
    result: () => {
      workspaces.createSession({ id: "ws_opened", root: "/tmp/project" });
      return { structuredContent: { workspace_id: "ws_opened" } };
    },
  });

  assert.deepEqual(activity.listWorkspaces().map((workspace) => workspace.workspaceId), ["ws_opened"]);
  const [turn] = activity.listTurns("ws_opened");
  const [opened] = activity.listToolCalls(turn!.id);
  assert.equal(opened?.toolName, "open_workspace");
  assert.equal(opened?.conversationScopeId, "conversation-1");
  assert.equal(opened?.requestId, "7");
});

test("journal redacts secrets, caps payloads, and keeps errors", async (t) => {
  const { journal, activity } = await journalFixture(t, ["ws_redact"]);

  await call(journal, "exec_command", {
    workspace_id: "ws_redact",
    cmd: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.test",
    env: { GITHUB_TOKEN: "ghp_shouldnotpersist", max_output_tokens: 100 },
  }, {
    result: { content: [{ type: "text", text: "x".repeat(20_000) }], _meta: { card: { patch: "large" } } },
  });
  await assert.rejects(call(journal, "read", { workspace_id: "ws_redact", path: "missing" }, {
    error: new Error("ENOENT"),
  }));

  const [turn] = activity.listTurns("ws_redact");
  const [exec, failed] = activity.listToolCalls(turn!.id);
  const serialized = JSON.stringify(exec);
  assert.doesNotMatch(serialized, /abcdefghijklmnop|ghp_should/);
  assert.match(serialized, /\[redacted\]/);
  assert.deepEqual((exec?.arguments as { env: unknown }).env, { GITHUB_TOKEN: "[redacted]", max_output_tokens: 100 });
  assert.ok(serialized.length < 10_000);
  assert.equal(serialized.includes("_meta"), false);
  assert.deepEqual(
    { isError: failed?.isError, error: failed?.error },
    { isError: true, error: { name: "Error", message: "ENOENT" } },
  );
  assert.equal(turn?.failedToolCalls, 1);
});

test("journal failures never replace the tool result", async (t) => {
  const { journal, activity } = await journalFixture(t, ["ws_closed"], () => {
    throw new Error("reporter failed too");
  });

  activity.close();
  const result = await journal.capture({
    toolName: "read",
    arguments: { workspace_id: "ws_closed" },
    extra: {},
    operation: async () => "tool result",
  });

  assert.equal(result, "tool result");
});

async function journalFixture(
  t: TestContext,
  workspaceIds: string[],
  onError?: (error: unknown) => void,
) {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-journal-test-"));
  const workspaces = new SqliteWorkspaceStore(stateDir);
  for (const id of workspaceIds) workspaces.createSession({ id, root: "/tmp/project" });
  const activity = new WorkspaceActivityStore(stateDir);
  const journal = new WorkspaceActivityJournal(activity, onError);
  t.after(async () => {
    try {
      activity.close();
    } catch {
      // Some tests close the store early.
    }
    workspaces.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return { journal, activity, workspaces };
}

function call(
  journal: WorkspaceActivityJournal,
  toolName: string,
  args: Record<string, unknown>,
  options: { meta?: Record<string, unknown>; result?: unknown; error?: Error } = {},
): Promise<unknown> {
  return journal.capture({
    toolName,
    arguments: args,
    extra: { _meta: options.meta, requestId: 7 },
    operation: async () => {
      if (options.error) throw options.error;
      return typeof options.result === "function" ? (options.result as () => unknown)() : options.result ?? {};
    },
  });
}
