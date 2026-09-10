import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkspaceToolCalls } from "./workspace-activity.js";
import type { WorkspaceToolCallSummary } from "./workspace-activity-store.js";

test("show_changes closes one review-backed activity group", () => {
  const calls = [
    call(1, "read", "2026-09-11T00:00:00.000Z"),
    call(2, "exec_command", "2026-09-11T00:00:01.000Z"),
    call(3, "apply_patch", "2026-09-11T00:00:02.000Z"),
    { ...call(4, "show_changes", "2026-09-11T00:00:03.000Z"), reviewRef: "abc" },
    call(5, "read", "2026-09-11T00:00:04.000Z"),
  ];

  const groups = groupWorkspaceToolCalls(calls);
  assert.equal(groups.length, 2);
  assert.equal(groups[1]?.id, "review:abc");
  assert.equal(groups[1]?.kind, "review");
  assert.deepEqual(groups[1]?.calls.map((entry) => entry.toolName), [
    "read",
    "exec_command",
    "apply_patch",
    "show_changes",
  ]);
  assert.equal(groups[0]?.id, "activity:5");
});

test("read-only activity uses inactivity gaps without mixing conversations", () => {
  const groups = groupWorkspaceToolCalls([
    call(1, "read", "2026-09-11T00:00:00.000Z", "conversation-a"),
    call(2, "read", "2026-09-11T00:00:30.000Z", "conversation-b"),
    call(3, "read", "2026-09-11T00:03:00.000Z", "conversation-a"),
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.calls.map((entry) => entry.id)), [[3], [2], [1]]);
  assert.ok(groups.every((group) => group.kind === "inferred"));
});

function call(
  id: number,
  toolName: string,
  startedAt: string,
  conversationScopeId = "conversation-a",
): WorkspaceToolCallSummary {
  return {
    id,
    workspaceId: "ws_test",
    conversationScopeId,
    toolName,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
  };
}
