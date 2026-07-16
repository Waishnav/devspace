import assert from "node:assert/strict";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import {
  CodexSdkLocalAgentRuntime,
  LocalAgentRunController,
  createCodexSdkLocalAgentRuntime,
  type CodexThreadLike,
  type LocalAgentEvent,
} from "./local-agent-runtime.js";

function completedEvents(sessionId: string, first = "first", final = "final"): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: sessionId },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: first },
    },
    {
      type: "item.completed",
      item: { id: "message-2", type: "agent_message", text: final },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ];
}

class FakeThread implements CodexThreadLike {
  prompts: string[] = [];
  signals: AbortSignal[] = [];
  returns = 0;

  constructor(
    readonly id: string | null,
    private readonly streamFactory: (signal: AbortSignal) => AsyncGenerator<ThreadEvent> =
      () => this.createCompletedStream(),
  ) {}

  async runStreamed(prompt: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.prompts.push(prompt);
    assert.ok(options?.signal);
    this.signals.push(options.signal);
    return { events: this.streamFactory(options.signal) };
  }

  private async *createCompletedStream(): AsyncGenerator<ThreadEvent> {
    try {
      for (const event of completedEvents(this.id ?? "new-thread")) yield event;
    } finally {
      this.returns += 1;
    }
  }
}

class FakeCodex {
  started: ThreadOptions[] = [];
  resumed: Array<{ id: string; options?: ThreadOptions }> = [];
  readonly startThreadInstance = new FakeThread(null);
  readonly resumeThreadInstance = new FakeThread("existing-thread");

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
assert.equal(readOnly.finalResponse, "final");
assert.equal(readOnly.items.length, 2);
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
assert.equal(resumed.providerSessionId, "existing-thread");
assert.deepEqual(codex.resumed[0]?.options, {
  workingDirectory: "/tmp/project",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  model: undefined,
  modelReasoningEffort: undefined,
});

const unconsumed = await runtime.start({ prompt: "unconsumed", workspace: "/tmp/project" });
assert.equal((await unconsumed.result()).finalResponse, "final");
const events: LocalAgentEvent[] = [];
for await (const event of unconsumed.events()) events.push(event);
assert.equal(events[0]?.type, "lifecycle");
assert.equal(events[1]?.type, "session");
assert.deepEqual(events.filter((event) => event.type === "terminal").map((event) => event.outcome), ["succeeded"]);
await unconsumed.dispose();

let interruptReturns = 0;
const blockingThread = new FakeThread(null, async function* (signal) {
  try {
    yield { type: "thread.started", thread_id: "cancel-thread" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    throw signal.reason;
  } finally {
    interruptReturns += 1;
  }
});
const cancellingRuntime = new CodexSdkLocalAgentRuntime({
  startThread: () => blockingThread,
  resumeThread: () => blockingThread,
});
const cancelled = await cancellingRuntime.start({ prompt: "wait", workspace: "/tmp/project" });
const cancelledResult = cancelled.result().then(
  () => "resolved",
  (error: Error) => error.name,
);
await cancelled.cancel("stop now");
await cancelled.cancel("stop again");
assert.equal(await cancelledResult, "AbortError");
await cancelled.dispose();
await cancelled.dispose();
assert.equal(blockingThread.signals[0]?.aborted, true);
assert.equal(interruptReturns, 1);

const buffered = new LocalAgentRunController("test");
buffered.emit({ type: "session", providerSessionId: "preserved-session", resumed: false });
for (let index = 0; index < 200; index += 1) {
  buffered.emit({ type: "permission", phase: "requested", tool: String(index) });
}
buffered.emit({
  type: "warning",
  message: "metadata",
  metadata: { authorization: "secret", safe: "visible" },
});
buffered.succeed({
  provider: "test",
  providerSessionId: "preserved-session",
  finalResponse: "ok",
  items: [],
});
await buffered.result();
const bufferedEvents: LocalAgentEvent[] = [];
for await (const event of buffered.events()) bufferedEvents.push(event);
assert.equal(bufferedEvents.some((event) => event.type === "session"), true);
const metadataWarning = bufferedEvents.find((event) => event.type === "warning");
assert.deepEqual(metadataWarning?.metadata, { authorization: "[redacted]", safe: "visible" });
assert.equal(bufferedEvents.filter((event) => event.type === "terminal").length, 1);

const created = await createCodexSdkLocalAgentRuntime(undefined, () => new FakeCodex());
assert.equal(created.provider, "codex");

await assert.rejects(
  runtime.start({
    prompt: "invalid policy",
    workspace: "/tmp/project",
    policy: {
      version: 1,
      mode: "workflow",
      access: "full_access",
      environment: {},
    } as never,
  }),
  /Invalid workflow local-agent policy/,
);

{
  const iteratorController = new LocalAgentRunController("iterator-test");
  const iterator = iteratorController.events()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "lifecycle");
  const pending = iterator.next();
  await iterator.return?.();
  assert.equal((await pending).done, true);
  assert.equal((await iterator.next()).done, true);
  iteratorController.succeed({
    provider: "iterator-test",
    providerSessionId: null,
    finalResponse: "ok",
    items: [],
  });
  await iteratorController.result();
}

{
  const abortController = new AbortController();
  abortController.abort("already stopped");
  const cancellationController = new LocalAgentRunController("cancel-order", abortController.signal);
  let releaseCancellation!: () => void;
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const order: string[] = [];
  cancellationController.setLifecycle({
    cancel: async () => {
      order.push("cancel-start");
      await cancellationGate;
      order.push("cancel-end");
    },
    dispose: async () => {
      order.push("dispose");
    },
  });
  const disposal = cancellationController.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["cancel-start"]);
  releaseCancellation();
  await disposal;
  assert.deepEqual(order, ["cancel-start", "cancel-end", "dispose"]);
}

{
  let removed = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => { removed += 1; },
  } as unknown as AbortSignal;
  const listenerController = new LocalAgentRunController("listener-test", signal);
  listenerController.succeed({
    provider: "listener-test",
    providerSessionId: null,
    finalResponse: "ok",
    items: [],
  });
  await listenerController.result();
  assert.equal(removed, 1);
}
