import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceActivityStore } from "./workspace-activity-store.js";

test("workspace activity persists raw tool calls across store reopen", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-store-test-"));
  const workspaces = new SqliteWorkspaceStore(stateDir);
  workspaces.createSession({ id: "ws_test", root: "/tmp/project", mode: "checkout" });
  workspaces.close();

  const first = new WorkspaceActivityStore(stateDir);
  const callId = first.startCall({
    workspaceId: "ws_test",
    conversationScopeId: "conversation-1",
    requestId: "request-1",
    toolName: "read",
    arguments: { workspace_id: "ws_test", path: "README.md" },
    startedAt: "2026-09-11T00:00:00.000Z",
  });
  first.finishCall(callId, {
    workspaceId: "ws_test",
    result: { structuredContent: { result: "hello" } },
    completedAt: "2026-09-11T00:00:00.010Z",
    durationMs: 10,
  });
  first.close();

  const reopened = new WorkspaceActivityStore(stateDir);
  t.after(async () => {
    reopened.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  assert.deepEqual(reopened.listCalls({ workspaceId: "ws_test", limit: 10 }), [
    {
      id: callId,
      workspaceId: "ws_test",
      conversationScopeId: "conversation-1",
      requestId: "request-1",
      toolName: "read",
      arguments: { workspace_id: "ws_test", path: "README.md" },
      result: { structuredContent: { result: "hello" } },
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:00.010Z",
      durationMs: 10,
    },
  ]);
});
