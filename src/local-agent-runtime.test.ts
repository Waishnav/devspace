import assert from "node:assert/strict";
import {
  codexAppServerError,
  codexAppServerThreadParams,
  codexAppServerTurnParams,
  CodexAppServerLocalAgentRuntime,
  createCodexAppServerLocalAgentRuntime,
  parseCodexAppServerEvents,
  runCodexAppServerTurn,
  sandboxModeFor,
  type CodexAppServerInvocation,
  type CodexAppServerRunner,
  type CodexAppServerWire,
} from "./local-agent-runtime.js";

const startedThreadParams = (writeMode: "read_only" | "allowed" | "full_access" | undefined = undefined) =>
  codexAppServerThreadParams({
    prompt: "inspect only",
    workspace: "/tmp/project",
    writeMode,
  });

assert.deepEqual(startedThreadParams().params, {
  cwd: "/tmp/project",
  approvalPolicy: "never",
  sandbox: "read-only",
});

assert.deepEqual(codexAppServerThreadParams({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
}), {
  method: "thread/start",
  params: {
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    model: "gpt-5.4",
  },
});

assert.deepEqual(codexAppServerThreadParams({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "full_access",
}), {
  method: "thread/resume",
  params: {
    threadId: "existing-thread",
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
});

assert.deepEqual(codexAppServerTurnParams({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
}, "thread-9"), {
  threadId: "thread-9",
  input: [{ type: "text", text: "make change" }],
  approvalPolicy: "never",
  sandboxPolicy: { type: "workspaceWrite" },
  model: "gpt-5.4",
  effort: "high",
});

assert.equal(sandboxModeFor("read_only"), "read-only");
assert.equal(sandboxModeFor("allowed"), "workspace-write");
assert.equal(sandboxModeFor("full_access"), "danger-full-access");

const invocations: CodexAppServerInvocation[] = [];
const runner: CodexAppServerRunner = async (invocation) => {
  invocations.push(invocation);
  return {
    threadId: "new-thread",
    finalResponse: `response:${invocation.input.prompt}`,
    items: [{ type: "agent_message", text: `response:${invocation.input.prompt}` }],
  };
};

const runtime = new CodexAppServerLocalAgentRuntime({
  command: "/usr/local/bin/codex",
  env: { PATH: "/usr/local/bin" },
  runner,
});

const readOnly = await runtime.run({
  prompt: "inspect only",
  workspace: "/tmp/project",
});
assert.equal(readOnly.provider, "codex");
assert.equal(readOnly.providerSessionId, "new-thread");
assert.equal(readOnly.finalResponse, "response:inspect only");
assert.deepEqual(readOnly.items, [{ type: "agent_message", text: "response:inspect only" }]);

const resumed = await runtime.run({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
});
assert.equal(resumed.providerSessionId, "new-thread");
assert.equal(resumed.finalResponse, "response:continue");
assert.deepEqual(invocations.at(-1)?.input, {
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
});

const created = createCodexAppServerLocalAgentRuntime({
  command: "/usr/local/bin/codex",
  env: process.env,
  runner,
});
assert.equal(created.provider, "codex");

const parsed = parseCodexAppServerEvents([
  {
    method: "thread/started",
    params: { thread: { id: "thread-9" } },
  },
  {
    method: "item/completed",
    params: { item: { id: "item_1", type: "tool_call", tool_name: "shell" } },
  },
  {
    method: "item/completed",
    params: { item: { id: "item_2", type: "agentMessage", text: "Final answer.", phase: "final_answer" } },
  },
]);
assert.equal(parsed.threadId, "thread-9");
assert.equal(parsed.finalResponse, "Final answer.");
assert.equal(parsed.items.length, 2);
assert.equal(parsed.failure, undefined);

const failed = parseCodexAppServerEvents([
  {
    method: "turn/completed",
    params: {
      turn: {
        status: "failed",
        error: { message: "model rejected: cli too old" },
        items: [],
      },
    },
  },
]);
assert.equal(failed.failure, "model rejected: cli too old");

const error = codexAppServerError("codex turn failed: boom", "0.147.0", "raw stderr");
assert.match(error.message, /codex turn failed: boom/);
assert.match(error.message, /codex version: 0\.147\.0/);
assert.match(error.message, /raw stderr/);

// A scripted in-memory app-server peer. Client requests are answered in FIFO
// order from `script`; each reply may also carry app-server notifications to
// emit (streamed item events, turn completed).
class MockCodexAppServer {
  readonly outgoing: Array<Record<string, unknown>> = [];
  private readonly lineHandlers: Array<(line: string) => void> = [];
  script: Array<{
    result: unknown;
    notifications?: Array<{ method: string; params: unknown }>;
  }> = [];

  wire(): CodexAppServerWire {
    return {
      writeLine: (line) => this.writeLine(line),
      onLine: (handler) => {
        this.lineHandlers.push(handler);
      },
      onExit: () => {},
      endStdin: () => {},
    };
  }

  writeLine(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>;
    this.outgoing.push(message);
    if (!("id" in message) || !("method" in message)) return;
    const reply = this.script.shift();
    if (!reply) return;
    const id = message.id;
    this.emit(JSON.stringify({ id, result: reply.result }));
    for (const notification of reply.notifications ?? []) {
      this.emit(JSON.stringify({ method: notification.method, params: notification.params }));
    }
  }

  private emit(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }
}

// Drive the full protocol offline: initialize -> thread/start -> turn/start on
// a scripted peer, collecting the final agent message from the turn payload.
{
  const peer = new MockCodexAppServer();
  peer.script = [
    { result: { userAgent: "probe/0.147.0" } },
    {
      result: { thread: { id: "thread-77" } },
      notifications: [{ method: "thread/started", params: { thread: { id: "thread-77" } } }],
    },
    {
      result: { turn: { id: "turn-1", status: "inProgress" } },
      notifications: [
        {
          method: "turn/started",
          params: { threadId: "thread-77", turn: { id: "turn-1", status: "inProgress" } },
        },
        {
          method: "item/completed",
          params: {
            item: { id: "item_2", type: "agentMessage", text: "Mock final.", phase: "final_answer" },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "thread-77",
            turn: {
              id: "turn-1",
              status: "completed",
              items: [
                { id: "item_2", type: "agentMessage", text: "Mock final.", phase: "final_answer" },
              ],
            },
          },
        },
      ],
    },
  ];
  const turn = await runCodexAppServerTurn(peer.wire(), {
    prompt: "hello",
    workspace: "/tmp/project",
    model: "gpt-5.4",
    thinking: "high",
  });
  assert.equal(turn.threadId, "thread-77");
  assert.equal(turn.finalResponse, "Mock final.");
  assert.deepEqual(turn.items, [
    { id: "item_2", type: "agentMessage", text: "Mock final.", phase: "final_answer" },
  ]);
  assert.deepEqual(peer.outgoing.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/start",
    "turn/start",
  ]);
  const turnRequest = peer.outgoing[3].params as Record<string, unknown>;
  assert.equal(turnRequest.threadId, "thread-77");
  assert.equal(turnRequest.effort, "high");
}

// A provider-session id resumes the thread instead of starting a new one.
{
  const peer = new MockCodexAppServer();
  peer.script = [
    { result: { userAgent: "probe/0.147.0" } },
    {
      result: { thread: { id: "thread-77" } },
      notifications: [{ method: "thread/resumed", params: { thread: { id: "thread-77" } } }],
    },
    {
      result: { turn: { id: "turn-1", status: "inProgress" } },
      notifications: [
        {
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              items: [
                { id: "item_2", type: "agentMessage", text: "Same thread.", phase: "final_answer" },
              ],
            },
          },
        },
      ],
    },
  ];
  const turn = await runCodexAppServerTurn(peer.wire(), {
    prompt: "continue",
    workspace: "/tmp/project",
    providerSessionId: "thread-77",
  });
  assert.equal(peer.outgoing[2].method, "thread/resume");
  const resumeParams = peer.outgoing[2].params as Record<string, unknown>;
  assert.equal(resumeParams.threadId, "thread-77");
  assert.equal(turn.finalResponse, "Same thread.");
}

// A failed turn surfaces the error from the terminal payload.
{
  const peer = new MockCodexAppServer();
  peer.script = [
    { result: { userAgent: "probe/0.147.0" } },
    {
      result: { thread: { id: "thread-77" } },
      notifications: [{ method: "thread/started", params: { thread: { id: "thread-77" } } }],
    },
    {
      result: { turn: { id: "turn-1", status: "inProgress" } },
      notifications: [
        {
          method: "turn/completed",
          params: {
            threadId: "thread-77",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "model rejected: cli too old" },
              items: [],
            },
          },
        },
      ],
    },
  ];
  await assert.rejects(
    runCodexAppServerTurn(peer.wire(), { prompt: "hello", workspace: "/tmp/project" }),
    /codex turn failed: model rejected: cli too old/,
  );
}

// A provider-gate failure arrives as a JSON-encoded error; the human-readable
// inner message is peeled out for the session error row.
{
  const peer = new MockCodexAppServer();
  peer.script = [
    { result: { userAgent: "probe/0.147.0" } },
    {
      result: { thread: { id: "thread-77" } },
      notifications: [{ method: "thread/started", params: { thread: { id: "thread-77" } } }],
    },
    {
      result: { turn: { id: "turn-1", status: "inProgress" } },
      notifications: [
        {
          method: "turn/completed",
          params: {
            threadId: "thread-77",
            turn: {
              id: "turn-1",
              status: "failed",
              error: {
                message: JSON.stringify({
                  type: "error",
                  status: 400,
                  error: {
                    type: "invalid_request_error",
                    message: "The 'bogus-model' model is not supported.",
                  },
                }),
              },
              items: [],
            },
          },
        },
      ],
    },
  ];
  await assert.rejects(
    runCodexAppServerTurn(peer.wire(), { prompt: "hello", workspace: "/tmp/project" }),
    /codex turn failed: The 'bogus-model' model is not supported\./,
  );
}