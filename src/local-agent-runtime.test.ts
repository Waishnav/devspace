import assert from "node:assert/strict";
import {
  codexCliArguments,
  codexCliError,
  CodexCliLocalAgentRuntime,
  createCodexCliLocalAgentRuntime,
  parseCodexCliLines,
  type CodexCliInvocation,
  type CodexCliRunner,
} from "./local-agent-runtime.js";

const startedArgs = (writeMode: "read_only" | "allowed" | "full_access" | undefined = undefined) =>
  codexCliArguments({
    prompt: "inspect only",
    workspace: "/tmp/project",
    writeMode,
  });

assert.deepEqual(startedArgs(), [
  "exec",
  "--experimental-json",
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "read-only",
  "--cd",
  "/tmp/project",
]);

assert.deepEqual(codexCliArguments({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
}), [
  "exec",
  "--experimental-json",
  "--model",
  "gpt-5.4",
  "--config",
  'model_reasoning_effort="high"',
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "workspace-write",
  "--cd",
  "/tmp/project",
]);

assert.deepEqual(codexCliArguments({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "full_access",
  thinking: "max",
}), [
  "exec",
  "--experimental-json",
  "--config",
  'model_reasoning_effort="max"',
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "danger-full-access",
  "--cd",
  "/tmp/project",
]);

assert.deepEqual(codexCliArguments({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "full_access",
}), [
  "exec",
  "--experimental-json",
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "danger-full-access",
  "--cd",
  "/tmp/project",
  "resume",
  "existing-thread",
]);

const invocations: CodexCliInvocation[] = [];
const runner: CodexCliRunner = async (invocation) => {
  invocations.push(invocation);
  return {
    threadId: "new-thread",
    finalResponse: `response:${invocation.prompt}`,
    items: [{ type: "agent_message", text: `response:${invocation.prompt}` }],
  };
};

const runtime = new CodexCliLocalAgentRuntime({
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
assert.deepEqual(invocations.at(-1)?.args, [
  "exec",
  "--experimental-json",
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "read-only",
  "--cd",
  "/tmp/project",
]);

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
assert.deepEqual(invocations.at(-1)?.args, [
  "exec",
  "--experimental-json",
  "--model",
  "gpt-5.4",
  "--config",
  'model_reasoning_effort="high"',
  "--config",
  'approval_policy="never"',
  "--sandbox",
  "workspace-write",
  "--cd",
  "/tmp/project",
  "resume",
  "existing-thread",
]);

const created = createCodexCliLocalAgentRuntime({
  command: "/usr/local/bin/codex",
  env: process.env,
  runner,
});
assert.equal(created.provider, "codex");

const parsed = parseCodexCliLines([
  JSON.stringify({ type: "thread.started", thread_id: "thread-9" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "tool_output", result: "ls" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "Final answer." },
  }),
]);
assert.equal(parsed.threadId, "thread-9");
assert.equal(parsed.finalResponse, "Final answer.");
assert.equal(parsed.items.length, 2);

const failed = parseCodexCliLines([
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "turn.failed",
    error: { message: "model rejected: cli too old" },
  }),
]);
assert.equal(failed.failure, "model rejected: cli too old");

const error = codexCliError("codex turn failed: boom", "0.147.0", "raw stderr");
assert.match(error.message, /codex turn failed: boom/);
assert.match(error.message, /codex version: 0\.147\.0/);
assert.match(error.message, /raw stderr/);