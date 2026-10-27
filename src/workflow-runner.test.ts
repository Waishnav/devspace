import { unsafeNarrow } from "./unsafe-narrow.js";
import { isJsonObject } from "./json-value.js";
import type { JsonValue, WireInput } from "./json-value.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runWorkflowScript } from "./workflow-runner.js";
import { WorkflowError } from "./workflow-types.js";

test("the guest sees its args but no host globals", async () => {
  const basic = await runWorkflowScript({
    source: `return { args, host: [typeof process, typeof require, typeof fetch, typeof globalThis.__hostCall, typeof globalThis.__emit] };`,
    args: { value: 42 },
    onAgent: () => null,
  });

  assert.deepEqual(basic, {
    args: { value: 42 },
    host: ["undefined", "undefined", "undefined", "undefined", "undefined"],
  });
});

test("dynamic code cannot recover host capabilities", async () => {
  assert.deepEqual(await runWorkflowScript({
    source: `return [
      Function("return typeof process")(),
      Function("return typeof globalThis.__hostCall")(),
      agent.constructor("return typeof globalThis.__emit")(),
    ];`,
    onAgent: () => null,
  }), ["undefined", "undefined", "undefined"], "dynamic code cannot recover host capabilities");
});

test("the guest has no module loader for host imports", async () => {
  assert.equal(await runWorkflowScript({
    source: `try { await import("node:fs"); return false; } catch { return true; }`,
    onAgent: () => null,
  }), true, "the guest has no module loader for host imports");
});

test("a __proto__ key in args stays an own property and pollutes nothing", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const prototypeArgs = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  assert.deepEqual(await runWorkflowScript({
    source: `return { own: Object.hasOwn(args, "__proto__"), polluted: ({}).polluted ?? null };`,
    args: prototypeArgs,
    onAgent: () => null,
  }), { own: true, polluted: null });
});

test("a __proto__ key in an agent result stays an own property and pollutes nothing", async () => {
  // SAFETY: The surrounding checks or construction already match this type.
  const prototypeResult = unsafeNarrow<JsonValue>(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.deepEqual(await runWorkflowScript({
    source: `
      const value = await agent("proto", { target: "worker" });
      return { own: Object.hasOwn(value, "__proto__"), polluted: ({}).polluted ?? null };
    `,
    onAgent: () => prototypeResult,
  }), { own: true, polluted: null });
});

test("agent calls reach onAgent with their prompt and target", async () => {
  const calls: Array<{ prompt: string; target: string }> = [];

  const bridged = await runWorkflowScript({
    source: `
      export const meta = { name: 'bridge', concurrency: 2 };
      return agent("inspect", { target: "reviewer", writeMode: "read_only", workspace: "shared" });
    `,
    onAgent: async (prompt, options) => {
      calls.push({ prompt, target: options.target });

      return { ok: true };
    },
  });

  assert.deepEqual(bridged, { ok: true });
  assert.deepEqual(calls, [{ prompt: "inspect", target: "reviewer" }]);
});

test("parallel settles each item independently", async () => {
  const parallel = await runWorkflowScript({
    source: `
      return parallel([30, 5, 10], async (wait, index) => {
        const result = await agent(String(wait), { target: "worker", label: String(index) });
        if (index === 1) throw new Error("expected failure");
        return result;
      }, 3);
    `,
    onAgent: async (prompt) => {
      await delay(Number(prompt));

      return Number(prompt) * 2;
    },
  });

  assert.deepEqual(parallel, [
    { status: "completed", value: 60 },
    { status: "failed", error: { code: "WORKFLOW_STEP_FAILED", message: "expected failure", retryable: false } },
    { status: "completed", value: 20 },
  ]);
});

test("pipeline threads each item through every stage", async () => {
  const pipeline = await runWorkflowScript({
    source: `
      return pipeline([2, 3],
        async (value, item, index) => await agent(String(value * 2 + index), { target: "worker" }),
        async (value, item, index) => ({ value, item, index }),
      );
    `,
    onAgent: (prompt) => Number(prompt),
  });

  assert.deepEqual(pipeline, [
    { status: "completed", value: { value: 4, item: 2, index: 0 } },
    { status: "completed", value: { value: 7, item: 3, index: 1 } },
  ]);
});

test("phase binds agent calls to the phase and emits phase and log events", async () => {
  const events: Array<{ type: string; data: unknown }> = [];

  const phased = await runWorkflowScript({
    source: `
      const value = await phase("review", boundAgent => boundAgent("go", { target: "worker" }));
      log("done", value);
      return value;
    `,
    onAgent: (_prompt, options) => options.phase ?? null,
    onEvent: (type, data) => { events.push({ type, data }); },
  });

  assert.equal(phased, "review");
  assert.deepEqual(events.map(({ type }) => type), ["phase_started", "phase_completed", "log"]);
  assert.deepEqual(events[2]?.data, ["done", "review"]);
});

// A slow async onEvent must not turn the child's exit after its result into a runner failure.
test("a slow async onEvent does not fail a run that already returned", async () => {
  const slowEvents: string[] = [];
  assert.equal(await runWorkflowScript({
    source: `log("late"); return "kept";`,
    onAgent: () => null,
    onEvent: async (type) => { await delay(150); slowEvents.push(type); },
  }), "kept");
  assert.deepEqual(slowEvents, ["log"]);
});

test("nested workflows run through onWorkflow", async () => {
  const nested = await runWorkflowScript({
    source: `return workflow("child", { n: 1 });`,
    onAgent: () => null,
    onWorkflow: (name, args) => ({ name, args: isJsonObject(args) ? args : null }),
  });

  assert.deepEqual(nested, { name: "child", args: { n: 1 } });
});

test("nested workflows beyond the depth limit fail even when caught", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `return workflow("grandchild", null);`,
      depth: 1,
      onAgent: () => null,
      onWorkflow: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_NESTING_LIMIT",
  );
  await assert.rejects(
    runWorkflowScript({
      source: `try { await workflow("grandchild", null); } catch {} return "swallowed";`,
      depth: 1,
      onAgent: () => null,
      onWorkflow: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_NESTING_LIMIT",
  );
});

test("an invalid agent call throws a catchable validation error", async () => {
  const caughtValidation = await runWorkflowScript({
    source: `try { await agent("go", {}); } catch (error) { return error.code; }`,
    onAgent: () => null,
  });

  assert.equal(caughtValidation, "WORKFLOW_INVALID_AGENT_CALL");
});

test("provider errors keep their code and retryability", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `return agent("fail", { target: "worker" });`,
      onAgent: () => { throw Object.assign(new Error("provider unavailable"), { code: "PROVIDER_DOWN", retryable: true }); },
    }),
    (error: WireInput) => error instanceof WorkflowError
      && error.code === "PROVIDER_DOWN"
      && error.retryable === true,
  );
});

test("unawaited agent calls fail the run", async () => {
  let finishDetached!: () => void;
  const detachedCall = new Promise<void>((resolve) => { finishDetached = resolve; });

  const detached = runWorkflowScript({
    source: `agent("detached", { target: "worker" }); return "done";`,
    onAgent: async () => { await detachedCall;

 return null; },
  });

  await assert.rejects(
    detached,
    (error: WireInput) => error instanceof WorkflowError && error.code === "UNAWAITED_CALLS",
  );
  finishDetached();
});

test("settled host-call handles do not accumulate against the QuickJS memory limit", async () => {
  const largeAgentResult = "x".repeat(240 * 1024);
  assert.equal(await runWorkflowScript({
    source: `
      for (let index = 0; index < 128; index += 1) {
        const value = await agent(String(index), { target: "worker" });
        if (value.length !== ${240 * 1024}) throw new Error("truncated agent result");
      }
      return 128;
    `,
    onAgent: () => largeAgentResult,
  }), 128, "settled host-call handles do not accumulate against the QuickJS memory limit");
});

test("logging past maxLogBytes fails even when caught", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `try { for (;;) log("0123456789"); } catch {} return "swallowed";`,
      limits: { maxLogBytes: 32 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_LOG_LIMIT",
  );
});

test("a busy loop fails at the timeout", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `while (true) {}`,
      limits: { timeoutMs: 2_000 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_TIMEOUT",
  );
});

test("unbounded recursion fails at the stack limit", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `const recurse = () => recurse(); return recurse();`,
      limits: { stackBytes: 64 * 1024 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_STACK_LIMIT",
  );
});

test("unbounded allocation fails at the memory limit", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `const values = []; for (;;) values.push("x".repeat(1024));`,
      limits: { memoryBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_MEMORY_LIMIT",
  );
});

test("aborting the signal cancels a pending agent call", async () => {
  const controller = new AbortController();
  let agentStarted!: () => void;
  const started = new Promise<void>((resolve) => { agentStarted = resolve; });

  const aborted = runWorkflowScript({
    source: `return agent("wait", { target: "worker" });`,
    signal: controller.signal,
    onAgent: async (): Promise<JsonValue> => {
      agentStarted();

      return await new Promise<JsonValue>(() => undefined);
    },
  });

  await started;
  controller.abort();
  await assert.rejects(
    aborted,
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_CANCELLED",
  );
});

test("a result past maxResultBytes fails", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `return "x".repeat(100);`,
      limits: { maxResultBytes: 32 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_RESULT_LIMIT",
  );
});

test("results that are not JSON-serializable fail", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `return () => "not JSON";`,
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_INVALID_JSON",
  );

  await assert.rejects(
    runWorkflowScript({
      source: `const value = {}; value.self = value; return value;`,
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_INVALID_JSON",
  );
});

test("source and args past their size limits fail", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: "return 1;".repeat(20),
      limits: { maxSourceBytes: 32 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_SIZE_LIMIT",
  );

  await assert.rejects(
    runWorkflowScript({
      source: `return args;`,
      args: "x".repeat(100),
      limits: { maxArgsBytes: 32 },
      onAgent: () => null,
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_SIZE_LIMIT",
  );
});

test("agent calls past maxOutstanding fail", async () => {
  await assert.rejects(
    runWorkflowScript({
      source: `return Promise.all(Array.from({ length: 3 }, () => agent("wait", { target: "worker" })));`,
      limits: { maxOutstanding: 2 },
      onAgent: async () => await new Promise(() => undefined),
    }),
    (error: WireInput) => error instanceof WorkflowError && error.code === "WORKFLOW_OUTSTANDING_LIMIT",
  );
});
