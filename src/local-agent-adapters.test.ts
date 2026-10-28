import type { WireInput } from "./json-value.js";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import {
  claudeCommandEnvironment,
  createLocalAgentDrivers,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
} from "./local-agent-adapters.js";
import { parseSubagentsConfig } from "./local-agent-config.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";

// Model and effort share one resolver shape: find the config option by category, flat or grouped.
test("ACP model and effort config updates resolve flat and grouped options and fail with guidance", () => {
  for (const { resolve, category, flavor, missing } of [
    { resolve: resolveAcpModelConfigUpdate, category: "model", flavor: "cursor" as const, missing: /does not expose a model/ },
    { resolve: resolveAcpEffortConfigUpdate, category: "thought_level", flavor: "copilot" as const, missing: /does not expose a reasoning effort option/ },
  ]) {
    const session = (options: WireInput[]) => ({
      sessionId: "session_1",
      newSessionResponse: { configOptions: [{ type: "select", id: "option_id", category, options }] },
    });

    assert.deepEqual(
      resolve(session([{ value: "a", name: "A" }, { value: "b", name: "B" }]), "b", flavor),
      { sessionId: "session_1", configId: "option_id", value: "b" },
    );
    assert.deepEqual(
      resolve(session([{ group: "g", name: "G", options: [{ value: "a", name: "A" }, { value: "c", name: "C" }] }]), "c", flavor),
      { sessionId: "session_1", configId: "option_id", value: "c" },
    );
    assert.throws(() => resolve(session([{ value: "a", name: "A" }]), "unknown", flavor), /Available values: a/);
    assert.throws(() => resolve(undefined, "a", flavor), /session metadata/);
    assert.throws(() => resolve({ newSessionResponse: { configOptions: [] } }, "a", flavor), /session id/);
    assert.throws(() => resolve({ sessionId: "session_1", newSessionResponse: { configOptions: [] } }, "a", flavor), missing);
  }
});

test("the Claude command environment drops parent Claude Code session variables", () => {
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
});

test("the OpenCode final response is the last assistant text or structured output", () => {
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
            { type: "reasoning", text: "effort" },
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
            { type: "reasoning", text: "effort" },
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
        parts: [{ type: "reasoning", text: "effort" }],
      },
    }),
    '{"summary":"structured answer"}',
  );

  assert.equal(
    extractOpenCodeFinalResponse({
      data: {
        info: { id: "msg_tool_only", role: "assistant" },
        parts: [
          { type: "reasoning", text: "effort" },
          { type: "tool", tool: "bash", input: { command: "cat src/secret.ts" }, output: "secret" },
        ],
      },
    }),
    "",
  );
});

test("the Pi final response joins assistant text and ignores tool output", () => {
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
});

test("a Pi provider error is read from the failed assistant message", () => {
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
});

test("DevSpace's node_modules/.bin is removed from a provider PATH", () => {
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const userBin = "/home/user/.local/bin";
  assert.equal(
    removeDevspaceNodeModulesBinFromPath([devspaceBin, userBin].join(delimiter)),
    userBin,
  );
});

test("multiple instances of one driver are created with agent-scoped runtimes", () => {
  const subagents = parseSubagentsConfig({
    enabled: true,
    providers: [
      { id: "claude-work", driver: "claude", enabled: true },
      { id: "claude-personal", driver: "claude", enabled: true },
    ],
  });

  const drivers = createLocalAgentDrivers({ subagents });
  assert.deepEqual(
    drivers.map((driver) => [driver.providerInstanceId, driver.provider]),
    [["claude-work", "claude"], ["claude-personal", "claude"]],
  );
  assert.deepEqual(drivers.map((driver) => driver.runtimePolicy.scope), ["agent", "agent"]);
});
