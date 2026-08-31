import assert from "node:assert/strict";
import {
  observeAcpUpdate,
  observeClaudeMessage,
  observeOpenCodeResult,
  observePiEvent,
} from "./local-agent-observation.js";
import type { LocalAgentActivity, LocalAgentUsageSnapshot } from "./local-agent-runtime.js";

const observedActivity: LocalAgentActivity[] = [];
const observedUsage: LocalAgentUsageSnapshot[] = [];
const observer = {
  onActivity: (activity: LocalAgentActivity) => observedActivity.push(activity),
  onUsage: (usage: LocalAgentUsageSnapshot) => observedUsage.push(usage),
};

const openCodeUsage = observeOpenCodeResult({
  data: [{
    info: {
      role: "assistant",
      tokens: { input: 1_000, output: 250, cache: { read: 400, write: 50 } },
    },
    parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }],
  }],
}, observer);
assert.equal(openCodeUsage?.totalTokens, 1_250);
assert.equal(observedUsage.shift()?.state, "final");
assert.deepEqual(observedActivity.shift(), {
  kind: "command",
  status: "completed",
  label: "bash",
});

const piUsage = observePiEvent({
  type: "agent_end",
  usage: { input: 800, output: 200, total: 1_000 },
}, observer);
assert.equal(piUsage?.totalTokens, 1_000);
assert.deepEqual(observedUsage.shift(), piUsage);

observeAcpUpdate({
  update: {
    sessionUpdate: "tool_call_update",
    kind: "execute",
    title: "Run tests",
    status: "failed",
  },
}, observer);
assert.deepEqual(observedActivity.shift(), {
  kind: "command",
  status: "failed",
  label: "Run tests",
});

let claudeUsage = observeClaudeMessage({
  type: "assistant",
  message: { usage: { input_tokens: 100, output_tokens: 30 } },
}, undefined, observer);
claudeUsage = observeClaudeMessage({
  type: "result",
  usage: { input_tokens: 200, output_tokens: 60 },
}, claudeUsage, observer);
assert.deepEqual(claudeUsage, {
  inputTokens: 200,
  cachedInputTokens: undefined,
  cacheCreationInputTokens: undefined,
  outputTokens: 60,
  totalTokens: 260,
  state: "final",
});

console.log("local-agent-observation.test.ts: ok");
