import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceActivityJournal } from "./workspace-activity-journal.js";
import { WorkspaceActivityStore } from "./workspace-activity-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("journal associates open_workspace after the tool creates its workspace", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-journal-test-"));
  const workspaces = new SqliteWorkspaceStore(stateDir);
  const journal = new WorkspaceActivityJournal(stateDir);
  t.after(async () => {
    journal.close();
    workspaces.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await journal.capture({
    toolName: "open_workspace",
    arguments: { path: "/tmp/project" },
    extra: { _meta: { "openai/session": "conversation-1" }, requestId: 17 },
    operation: async () => {
      workspaces.createSession({ id: "ws_opened", root: "/tmp/project" });
      return { structuredContent: { workspace_id: "ws_opened" } };
    },
  });

  const activity = new WorkspaceActivityStore(stateDir);
  t.after(() => activity.close());
  const calls = activity.listCalls({ workspaceId: "ws_opened", limit: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolName, "open_workspace");
  assert.equal(calls[0]?.conversationScopeId, "conversation-1");
  assert.equal(calls[0]?.requestId, "17");
});

test("journal ignores historical show_changes replays", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-journal-test-"));
  const workspaces = new SqliteWorkspaceStore(stateDir);
  workspaces.createSession({ id: "ws_test", root: "/tmp/project" });
  const journal = new WorkspaceActivityJournal(stateDir);
  t.after(async () => {
    journal.close();
    workspaces.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await journal.capture({
    toolName: "show_changes",
    arguments: { workspace_id: "ws_test" },
    extra: { _meta: { "devspace/reviewRef": "abc" } },
    operation: async () => ({ structuredContent: { workspace_id: "ws_test", review_ref: "abc" } }),
  });

  const activity = new WorkspaceActivityStore(stateDir);
  t.after(() => activity.close());
  assert.deepEqual(activity.listCalls({ workspaceId: "ws_test", limit: 10 }), []);
});

test("journal failures never replace the tool result", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-journal-test-"));
  const errors: unknown[] = [];
  const journal = new WorkspaceActivityJournal(stateDir, (error) => errors.push(error));
  t.after(async () => {
    journal.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  journal.close();
  const result = await journal.capture({
    toolName: "read",
    arguments: { workspace_id: "missing" },
    extra: {},
    operation: async () => "tool result",
  });

  assert.equal(result, "tool result");
  assert.equal(errors.length, 1);
});
