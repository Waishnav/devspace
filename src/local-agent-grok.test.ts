import assert from "node:assert/strict";
import test from "node:test";
import {
  GrokPromptCompletionRegistry,
  normalizeGrokModelId,
  parseGrokPromptCompletion,
  readGrokSessionState,
  resolveGrokEffort,
  resolveGrokModelId,
} from "./local-agent-grok.js";

const sessionResponse = {
  sessionId: "grok_session_1",
  models: {
    currentModelId: "grok-4.5",
    availableModels: [
      {
        modelId: "grok-4.5",
        _meta: {
          reasoningEfforts: [
            { id: "high", value: "high" },
            { id: "low", value: "low" },
          ],
        },
      },
    ],
  },
};

test("session state resolves models and efforts and lists the available ones on a miss", () => {
  const state = readGrokSessionState(sessionResponse);
  assert.deepEqual(state, {
    currentModelId: "grok-4.5",
    availableModels: [{ id: "grok-4.5", reasoningEfforts: ["high", "low"] }],
  });
  assert.equal(normalizeGrokModelId("grok/grok-4.5"), "grok-4.5");
  assert.equal(resolveGrokModelId("grok-4.5", state), "grok-4.5");
  assert.equal(resolveGrokEffort("low", state, "grok-4.5"), "low");
  assert.throws(
    () => resolveGrokModelId("grok-unknown", state),
    /Available models: grok-4\.5/,
  );
  assert.throws(
    () => resolveGrokEffort("xhigh", state, "grok-4.5"),
    /Available efforts: high, low/,
  );
});

test("prompt completions are parsed from responses and turn_completed updates only", () => {
  assert.deepEqual(
    parseGrokPromptCompletion({
      sessionId: "grok_session_1",
      promptId: "prompt_1",
      stopReason: "end_turn",
    }),
    { sessionId: "grok_session_1", promptId: "prompt_1", stopReason: "end_turn" },
  );
  assert.deepEqual(
    parseGrokPromptCompletion({
      sessionId: "grok_session_1",
      update: { sessionUpdate: "turn_completed", requestId: "prompt_2", stopReason: "end_turn" },
    }),
    { sessionId: "grok_session_1", promptId: "prompt_2", stopReason: "end_turn" },
  );
  for (const incomplete of [
    { sessionId: "grok_session_1", promptId: "task-completed-123" },
    { sessionId: "grok_session_1", update: { sessionUpdate: "agent_message_chunk" } },
    { sessionId: "grok_session_1", update: { stopReason: "end_turn" } },
  ]) {
    assert.equal(parseGrokPromptCompletion(incomplete), undefined);
  }
});

test("the completion registry resolves the matching prompt once and ignores stale ones", async () => {
  const registry = new GrokPromptCompletionRegistry();
  const completion = registry.wait("grok_session_1", "prompt_3", 100, () => new Error("timed out"));
  registry.resolve({ sessionId: "grok_session_1", promptId: "stale" });
  registry.resolve({ sessionId: "grok_session_1", promptId: "prompt_3", stopReason: "end_turn" });
  assert.deepEqual(await completion, {
    sessionId: "grok_session_1",
    promptId: "prompt_3",
    stopReason: "end_turn",
  });
  registry.resolve({ sessionId: "grok_session_1", promptId: "prompt_3", stopReason: "end_turn" });
  assert.equal(registry.size, 0);
});

test("a completion wait times out", async () => {
  const registry = new GrokPromptCompletionRegistry();
  const timeout = registry.wait("grok_session_1", "prompt_timeout", 5, () => new Error("timed out"));
  const keepAlive = new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(timeout, /timed out/);
  await keepAlive;
});
