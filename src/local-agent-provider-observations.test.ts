import assert from "node:assert/strict";
import {
  extractAcpObservations,
  extractAcpUsage,
  extractClaudeObservations,
  extractClaudeUsage,
  extractCodexObservations,
  extractCodexUsage,
  extractOpenCodeObservations,
  extractOpenCodeUsage,
  extractPiObservations,
  extractPiUsage,
} from "./local-agent-provider-observations.js";

{
  const item = {
    type: "command_execution",
    id: "cmd-1",
    command: "npm test",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 8 },
  };
  const codexActivity = extractCodexObservations([item]).find((entry) => entry.kind === "activity");
  assert.equal(codexActivity?.activityId, "cmd-1");
  assert.equal(codexActivity?.toolStatus, "completed");
  assert.deepEqual(extractCodexUsage({ usage: { input_tokens: 12, output_tokens: 8 } }), {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
  });
}

{
  const messages = [
    { type: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "pwd" } }] },
    { type: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    { type: "result", usage: { input_tokens: 20, output_tokens: 4 } },
  ];
  assert.deepEqual(extractClaudeObservations(messages).filter((entry) => entry.kind === "activity").map((entry) => entry.toolStatus), ["started", "completed"]);
  assert.deepEqual(extractClaudeUsage(messages), { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
}

{
  const messages = [{
    info: { tokens: { input: 30, output: 5 } },
    parts: [{ type: "tool", callID: "call-1", tool: "grep", state: { status: "completed", output: "match" } }],
  }];
  const openCodeActivity = extractOpenCodeObservations(messages).find((entry) => entry.kind === "activity");
  assert.equal(openCodeActivity?.toolName, "grep");
  assert.equal(openCodeActivity?.toolStatus, "completed");
  assert.deepEqual(extractOpenCodeUsage(messages), { inputTokens: 30, outputTokens: 5, totalTokens: 35 });
}

{
  const event = { type: "tool_result", toolCallId: "pi-1", toolName: "read", status: "success", usage: { input: 4, output: 3 } };
  const piActivity = extractPiObservations([event]).find((entry) => entry.kind === "activity");
  assert.equal(piActivity?.activityId, "pi-1");
  assert.equal(piActivity?.toolStatus, "completed");
  assert.deepEqual(extractPiUsage(event), { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
}

for (const provider of ["cursor", "copilot"] as const) {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: `${provider}-1`,
    toolName: "edit",
    status: "completed",
    usage_update: { input_tokens: 9, output_tokens: 2 },
  };
  const acpActivity = extractAcpObservations(update).find((entry) => entry.kind === "activity");
  assert.equal(acpActivity?.toolName, "edit");
  assert.equal(acpActivity?.toolStatus, "completed");
  assert.deepEqual(extractAcpUsage(update), {
    inputTokens: 9,
    outputTokens: 2,
    totalTokens: 11,
  });
}

console.log("local-agent-provider-observations.test.ts: ok");
