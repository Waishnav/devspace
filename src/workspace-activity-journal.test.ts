import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceActivityJournal, journalJson } from "./workspace-activity-journal.js";
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

test("closing a turn deletes closed turns beyond maxTurns with their calls", async (t) => {
  const { journal, activity } = await journalFixture(t, ["ws_cap"], undefined, 2);

  for (let index = 0; index < 3; index += 1) {
    await call(journal, "read", { workspace_id: "ws_cap", path: "README.md" });
    await call(journal, "show_changes", { workspace_id: "ws_cap" }, {
      result: { structuredContent: { workspace_id: "ws_cap", review_ref: REVIEW_REF } },
    });
  }

  assert.deepEqual(activity.listTurns("ws_cap").map((turn) => turn.sequence), [3, 2]);
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

test("journal redacts credentials in commands and outputs", () => {
  const redacted = (value: string): string => JSON.parse(journalJson(value)) as string;

  const secrets = [
    "API_KEY=abc123def",
    "export GITHUB_TOKEN=ghx_notavendorshape",
    'DB_PASSWORD="hunter two"',
    "AWS_SECRET_ACCESS_KEY='abc/def+ghi'",
    "curl --password hunter2 https://example.test",
    "docker login --password=hunter2",
    "tool --api-key abc123",
    "curl -H 'Authorization: Bearer abc.def' https://example.test",
    'curl -H "authorization: basic dXNlcjpwYXNzd29yZA==" https://example.test',
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "token Bearer abcdefghijklmnopqrstuvwxyz0123",
    "git clone https://user:pass@github.com/acme/repo.git",
    "postgres://app:s3cret@db.internal:5432/app",
  ];

  for (const secret of secrets) {
    const output = redacted(`run: ${secret}`);
    assert.match(output, /\[redacted\]/, secret);
    assert.doesNotMatch(output, /abc123|hunter|ghx_|abc\/def|abc\.def|dXNlcj|s3cret|:pass@|abcdefghij/, secret);
  }

  assert.equal(redacted("export API_KEY=abc123 && run"), "export API_KEY=[redacted] && run");
  assert.equal(redacted("curl https://u:p@host/x"), "curl https://[redacted]@host/x");
});

test("journal leaves ordinary prose and code alone", () => {
  const unchanged = [
    "Basic functionality and basic configuration of the internationalization layer",
    "Authorization: required for write access",
    "bearer authentication is supported",
    "MAX_TOKENS=4096",
    "TOKEN_LIMIT=100 npm test",
    "export TOKEN=$(cat token.txt)",
    "API_KEY=$API_KEY node server.js",
    "docker login --password-stdin",
    "const tokenCount = 5; // password: string",
    "git clone https://github.com/acme/repo.git",
    "git clone ssh://git@github.com/acme/repo.git",
    "open http://localhost:3000/@user",
    "curl https://example.com:8080/path",
  ];

  for (const text of unchanged) {
    assert.equal(JSON.parse(journalJson(text)), text);
  }
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
  maxTurns?: number,
) {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-activity-journal-test-"));
  const workspaces = new SqliteWorkspaceStore(stateDir);

  for (const id of workspaceIds) workspaces.createSession({ id, root: "/tmp/project" });
  const activity = new WorkspaceActivityStore(stateDir, maxTurns);
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
