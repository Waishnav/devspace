import assert from "node:assert/strict";
import type { RunResult, RunStreamedResult, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import {
  CodexSdkLocalAgentRuntime,
  createCodexSdkLocalAgentRuntime,
  isNativeSchemaUnsupportedFailure,
} from "./local-agent-runtime.js";

const emptyTurn = (finalResponse: string): RunResult => ({
  finalResponse,
  items: [],
  usage: null,
});

class FakeThread {
  prompts: string[] = [];
  turnOptions: Array<{ outputSchema?: unknown; signal?: AbortSignal } | undefined> = [];

  constructor(readonly id: string | null) {}

  async run(
    prompt: string,
    turnOptions?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<RunResult> {
    this.prompts.push(prompt);
    this.turnOptions.push(turnOptions);
    if (turnOptions?.outputSchema) {
      return emptyTurn('{"ok":true}');
    }
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
assert.equal(readOnly.structured, undefined);
assert.deepEqual(codex.startThreadInstance.prompts, ["inspect only"]);
assert.deepEqual(codex.startThreadInstance.turnOptions, [undefined]);
assert.deepEqual(codex.started[0], {
  workingDirectory: "/tmp/project",
  sandboxMode: "read-only",
  approvalPolicy: "never",
  model: undefined,
  modelReasoningEffort: undefined,
});

const streamedEvents: ThreadEvent[] = [
  { type: "thread.started", thread_id: "stream-thread" },
  {
    type: "item.started",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "ok",
      exit_code: 0,
      status: "completed",
    },
  },
  { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "done" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 },
  },
];
const streamingThread = {
  id: "stream-thread",
  async run(): Promise<RunResult> { throw new Error("unreachable"); },
  async runStreamed(): Promise<RunStreamedResult> {
    return { events: (async function* () { yield* streamedEvents; })() };
  },
};
const observedSessions: string[] = [];
const observedActivity: string[] = [];
const observedUsage: number[] = [];
const streamedRuntime = new CodexSdkLocalAgentRuntime({
  startThread: () => streamingThread,
  resumeThread: () => streamingThread,
});
const streamed = await streamedRuntime.run(
  { prompt: "test", workspace: "/tmp/project" },
  {
    onSession: (id) => observedSessions.push(id),
    onActivity: (activity) => observedActivity.push(`${activity.status}:${activity.label}`),
    onUsage: (usage) => observedUsage.push(usage.totalTokens),
  },
);
assert.equal(streamed.finalResponse, "done");
assert.equal(streamed.usage?.totalTokens, 130);
assert.deepEqual(observedSessions, ["stream-thread"]);
assert.deepEqual(observedActivity, ["running:npm test", "completed:npm test"]);
assert.deepEqual(observedUsage, [130]);

await runtime.run({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  effort: "high",
});

assert.deepEqual(codex.started[1], {
  workingDirectory: "/tmp/project",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  model: "gpt-5.4",
  modelReasoningEffort: "high",
});

const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

const structured = await runtime.run({
  prompt: "return structured",
  workspace: "/tmp/project",
  schema,
});

assert.equal(structured.finalResponse, '{"ok":true}');
assert.deepEqual(structured.structured, { ok: true });
assert.deepEqual(codex.startThreadInstance.turnOptions.at(-1), {
  outputSchema: schema,
});

const resumed = await runtime.run({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "full_access",
});

assert.equal(resumed.providerSessionId, "resumed-thread");
assert.deepEqual(codex.resumeThreadInstance.prompts, ["continue"]);
assert.deepEqual(codex.resumeThreadInstance.turnOptions, [undefined]);
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

assert.equal(
  isNativeSchemaUnsupportedFailure(
    new Error("Invalid output schema: keyword is not supported"),
  ),
  true,
);
assert.equal(isNativeSchemaUnsupportedFailure(new Error("authentication failed")), false);
