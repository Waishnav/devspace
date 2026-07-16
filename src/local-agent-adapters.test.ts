import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ClaudeLocalAgentAdapter,
  claudeCommandEnvironment,
  createLocalAgentAdapter,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  extractPiStreamingText,
  piCommandEnvironment,
  resolveAcpModelConfigUpdate,
  resolveAcpPermissionRequest,
  resolveAcpThinkingConfigUpdate,
} from "./local-agent-adapters.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

const providers: LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

for (const provider of providers) {
  const adapter = createLocalAgentAdapter(provider);
  assert.equal(adapter.provider, provider);
  assert.equal(typeof adapter.start, "function");
  assert.equal(typeof adapter.run, "function");
}

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [
            { value: "claude-sonnet-4.5", name: "Sonnet" },
            { value: "gpt-5.4", name: "GPT 5.4" },
          ],
        },
      ],
    },
  }, "gpt-5.4", "cursor"),
  { sessionId: "session_model_1", configId: "model", value: "gpt-5.4" },
);

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model_config",
          category: "model",
          options: [
            {
              group: "claude",
              name: "Claude",
              options: [
                { value: "claude-sonnet-4.5", name: "Sonnet" },
                { value: "claude-opus-4.5", name: "Opus" },
              ],
            },
          ],
        },
      ],
    },
  }, "claude-opus-4.5", "copilot"),
  { sessionId: "session_model_2", configId: "model_config", value: "claude-opus-4.5" },
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [{ value: "gpt-5.4", name: "GPT 5.4" }],
        },
      ],
    },
  }, "unknown-model", "cursor"),
  /Available values: gpt-5\.4/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate(undefined, "gpt-5.4", "cursor"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({ newSessionResponse: { configOptions: [] } }, "gpt-5.4", "cursor"),
  /session id/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_4",
    newSessionResponse: { configOptions: [] },
  }, "gpt-5.4", "cursor"),
  /does not expose a model/,
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "effort",
          category: "thought_level",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
  }, "high", "cursor"),
  { sessionId: "session_1", configId: "effort", value: "high" },
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [
            {
              group: "reasoning",
              name: "Reasoning",
              options: [
                { value: "medium", name: "Medium" },
                { value: "xhigh", name: "X High" },
              ],
            },
          ],
        },
      ],
    },
  }, "xhigh", "copilot"),
  { sessionId: "session_2", configId: "thoughts", value: "xhigh" },
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [{ value: "low", name: "Low" }],
        },
      ],
    },
  }, "max", "cursor"),
  /Available values: low/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate(undefined, "high", "copilot"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({ newSessionResponse: { configOptions: [] } }, "high", "copilot"),
  /session id/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_4",
    newSessionResponse: { configOptions: [] },
  }, "high", "copilot"),
  /does not expose a thinking option/,
);

{
  const env = claudeCommandEnvironment({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_AGENT_SDK_VERSION: "test",
    PATH: "/usr/bin",
  });

  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
  assert.equal(env.CLAUDE_AGENT_SDK_VERSION, undefined);
  assert.equal(env.PATH, "/usr/bin");
}

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        info: { id: "msg_user", role: "user" },
        parts: [{ type: "text", text: "Review the change." }],
      },
      {
        info: { id: "msg_assistant", role: "assistant" },
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "grep", input: { pattern: "secret" }, output: "src/foo.ts" },
          { type: "text", text: "Final OpenCode response." },
        ],
      },
    ],
  }),
  "Final OpenCode response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        id: "msg_user",
        type: "user",
        text: "Review the change.",
      },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", name: "grep", state: { status: "completed", result: "src/foo.ts" } },
          { type: "text", text: "Final OpenCode v2 response." },
        ],
      },
    ],
  }),
  "Final OpenCode v2 response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: {
        id: "msg_structured",
        role: "assistant",
        structured: { summary: "structured answer" },
      },
      parts: [{ type: "reasoning", text: "thinking" }],
    },
  }),
  '{"summary":"structured answer"}',
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: { id: "msg_tool_only", role: "assistant" },
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", tool: "bash", input: { command: "cat src/secret.ts" }, output: "secret" },
      ],
    },
  }),
  "",
);

assert.equal(
  extractPiFinalResponse({
    data: {
      messages: [
        { role: "user", content: "Review the change." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/foo.ts" } },
            { type: "text", text: "Final Pi response." },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "tool output" }],
        },
      ],
    },
  }),
  "Final Pi response.",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first part" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
          { type: "text", text: "second part" },
        ],
      },
    ],
  }),
  "first part\n\nsecond part",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: "secret output" },
      { role: "bashExecution", command: "cat src/secret.ts", output: "secret output", timestamp: 1 },
    ],
  }),
  "",
);

assert.equal(
  extractPiProviderError({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
      },
    ],
  }),
  "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
);

assert.equal(
  extractPiStreamingText([
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Final " }] },
      assistantMessageEvent: { type: "text_delta", delta: "Final " },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Pi response." }] },
      assistantMessageEvent: { type: "text_delta", delta: "Pi response." },
    },
  ]),
  "Final Pi response.",
);

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const userBin = "/home/user/.local/bin";
  assert.equal(
    removeDevspaceNodeModulesBinFromPath([devspaceBin, userBin].join(delimiter)),
    userBin,
  );

  const env = piCommandEnvironment({
    PATH: [devspaceBin, userBin].join(delimiter),
  });

  assert.equal(env.PATH, userBin);
}

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const env = piCommandEnvironment({
    PI_COMMAND: "/custom/pi",
    PATH: [devspaceBin, "/home/user/.local/bin"].join(delimiter),
  });

  assert.equal(env.PATH, [devspaceBin, "/home/user/.local/bin"].join(delimiter));
}

{
  const readOnlyPolicy = {
    version: 1,
    mode: "workflow",
    access: "read_only",
    environment: Object.freeze({ PATH: "/usr/bin", HOME: "/home/user" }),
  } as const;
  const denied = resolveAcpPermissionRequest({
    toolCall: { kind: "edit" },
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  }, readOnlyPolicy);
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.response, {
    outcome: { outcome: "selected", optionId: "reject" },
  });

  const read = resolveAcpPermissionRequest({
    toolCall: { kind: "read" },
    options: [{ optionId: "allow", kind: "allow_once" }],
  }, readOnlyPolicy);
  assert.equal(read.allowed, true);
  assert.deepEqual(read.response, {
    outcome: { outcome: "selected", optionId: "allow" },
  });

  const noSafeOption = resolveAcpPermissionRequest({
    toolCall: { kind: "execute" },
    options: [{ optionId: "allow", kind: "allow_always" }],
  }, readOnlyPolicy);
  assert.deepEqual(noSafeOption.response, { outcome: { outcome: "cancelled" } });
}

{
  let capturedOptions: Record<string, unknown> | undefined;
  let closed = 0;
  const query = (async function* () {
    yield {
      type: "stream_event",
      session_id: "claude-session",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello " },
      },
    } as never;
    yield {
      type: "result",
      subtype: "success",
      session_id: "claude-session",
      result: "Hello Claude",
    } as never;
  })() as AsyncGenerator<never, void> & { interrupt(): Promise<void>; close(): void };
  query.interrupt = async () => undefined;
  query.close = () => { closed += 1; };
  const adapter = new ClaudeLocalAgentAdapter((parameters) => {
    capturedOptions = parameters.options as unknown as Record<string, unknown>;
    return query as never;
  });
  const handle = await adapter.start({ prompt: "hello", workspace: "/tmp/project" });
  const result = await handle.result();
  assert.equal(result.providerSessionId, "claude-session");
  assert.equal(result.finalResponse, "Hello Claude");
  assert.equal(capturedOptions?.includePartialMessages, true);
  assert.equal(capturedOptions?.permissionMode, "bypassPermissions");
  const eventTypes: string[] = [];
  for await (const event of handle.events()) eventTypes.push(event.type);
  assert.deepEqual(eventTypes, ["lifecycle", "session", "output", "terminal"]);
  await handle.dispose();
  await handle.dispose();
  assert.equal(closed, 1);
}

{
  const query = (async function* () {
    yield {
      type: "result",
      subtype: "error_during_execution",
      session_id: "claude-error-session",
      errors: ["provider unavailable"],
    } as never;
  })() as AsyncGenerator<never, void> & { interrupt(): Promise<void>; close(): void };
  query.interrupt = async () => undefined;
  query.close = () => undefined;
  const adapter = new ClaudeLocalAgentAdapter(() => query as never);
  const handle = await adapter.start({ prompt: "hello", workspace: "/tmp/project" });
  await assert.rejects(handle.result(), /provider unavailable/);
  await handle.dispose();
}

{
  const compatibility = resolveAcpPermissionRequest({
    toolCall: { kind: "edit" },
    options: [
      { optionId: "always", kind: "allow_always" },
      { optionId: "once", kind: "allow_once" },
    ],
  });
  assert.deepEqual(compatibility.response, {
    outcome: { outcome: "selected", optionId: "once" },
  });
}

{
  const workflowPolicy = {
    version: 1,
    mode: "workflow",
    access: "workspace_write",
    environment: Object.freeze({ PATH: process.env.PATH ?? "" }),
  } as const;
  await assert.rejects(
    createLocalAgentAdapter("cursor").start({
      prompt: "edit",
      workspace: "/tmp/project",
      policy: workflowPolicy,
    }),
    /cannot currently enforce DevSpace workflow filesystem policy/,
  );
}

{
  const root = await mkdtemp(join(tmpdir(), "devspace-claude-policy-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(workspace, "escape"));

  let capturedOptions: Record<string, unknown> | undefined;
  const query = (async function* () {
    yield {
      type: "result",
      subtype: "success",
      session_id: "claude-workflow-session",
      result: "ok",
    } as never;
  })() as AsyncGenerator<never, void> & { interrupt(): Promise<void>; close(): void };
  query.interrupt = async () => undefined;
  query.close = () => undefined;
  const originalClaudeCommand = process.env.CLAUDE_COMMAND;
  process.env.CLAUDE_COMMAND = "/ambient/claude-must-not-run";
  try {
    const adapter = new ClaudeLocalAgentAdapter((parameters) => {
      capturedOptions = parameters.options as unknown as Record<string, unknown>;
      return query as never;
    });
    const handle = await adapter.start({
      prompt: "inspect",
      workspace,
      policy: {
        version: 1,
        mode: "workflow",
        access: "workspace_write",
        environment: Object.freeze({ PATH: process.env.PATH ?? "" }),
      },
    });
    await handle.result();
    assert.deepEqual(capturedOptions?.settingSources, []);
    assert.equal(capturedOptions?.strictMcpConfig, true);
    assert.deepEqual(capturedOptions?.mcpServers, {});
    assert.deepEqual(capturedOptions?.plugins, []);
    assert.deepEqual(capturedOptions?.skills, []);
    assert.deepEqual(capturedOptions?.agents, {});
    assert.notEqual(capturedOptions?.pathToClaudeCodeExecutable, "/ambient/claude-must-not-run");

    const canUseTool = capturedOptions?.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    assert.equal((await canUseTool("Write", { file_path: join(workspace, "new.txt") })).behavior, "allow");
    assert.equal((await canUseTool("Write", { file_path: join(workspace, "escape", "secret.txt") })).behavior, "deny");
    assert.equal((await canUseTool("Write", { file_path: join(workspace, "escape", "new.txt") })).behavior, "deny");
    await handle.dispose();
  } finally {
    if (originalClaudeCommand === undefined) delete process.env.CLAUDE_COMMAND;
    else process.env.CLAUDE_COMMAND = originalClaudeCommand;
    await rm(root, { recursive: true, force: true });
  }
}
