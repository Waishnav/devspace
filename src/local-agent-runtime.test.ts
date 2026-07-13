import assert from "node:assert/strict";
import type { RunResult, ThreadOptions } from "@openai/codex-sdk";
import {
  CodexSdkLocalAgentRuntime,
  createCodexSdkLocalAgentRuntime,
} from "./local-agent-runtime.js";

const emptyTurn = (finalResponse: string): RunResult => ({
  finalResponse,
  items: [],
  usage: null,
});

class FakeThread {
  prompts: string[] = [];

  constructor(readonly id: string | null) {}

  async run(prompt: string): Promise<RunResult> {
    this.prompts.push(prompt);
    return emptyTurn(`response:${prompt}`);
  }
}

class FakeCodex {
  started: ThreadOptions[] = [];
  resumed: Array<{ id: string; options?: ThreadOptions }> = [];
  readonly startThreadInstance = new FakeThread("new-thread");
  readonly resumeThreadInstance = new FakeThread("resumed-thread");

  startThread(options?: ThreadOptions): FakeThread {
    this.started.push(options ?? {});
    return this.startThreadInstance;
  }

  resumeThread(id: string, options?: ThreadOptions): FakeThread {
    this.resumed.push({ id, options });
    return this.resumeThreadInstance;
  }
}

const codex = new FakeCodex();
const runtime = new CodexSdkLocalAgentRuntime(codex);
const readOnly = await runtime.run({
  prompt: "inspect only",
  workspace: "/tmp/project",
});

assert.equal(readOnly.provider, "codex");
assert.equal(readOnly.providerSessionId, "new-thread");
assert.equal(readOnly.finalResponse, "response:inspect only");
assert.deepEqual(codex.startThreadInstance.prompts, ["inspect only"]);
assert.deepEqual(codex.started[0], {
  workingDirectory: "/tmp/project",
  sandboxMode: "read-only",
  approvalPolicy: "never",
  model: undefined,
  modelReasoningEffort: undefined,
});

await runtime.run({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
});

assert.deepEqual(codex.started[1], {
  workingDirectory: "/tmp/project",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  model: "gpt-5.4",
  modelReasoningEffort: "high",
});

const resumed = await runtime.run({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "full_access",
});

assert.equal(resumed.providerSessionId, "resumed-thread");
assert.deepEqual(codex.resumeThreadInstance.prompts, ["continue"]);
assert.deepEqual(codex.resumed, [
  {
    id: "existing-thread",
    options: {
      workingDirectory: "/tmp/project",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      model: undefined,
      modelReasoningEffort: undefined,
    },
  },
]);

const created = await createCodexSdkLocalAgentRuntime(undefined, () => new FakeCodex());
assert.equal(created.provider, "codex");
