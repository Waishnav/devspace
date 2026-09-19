import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { executeWorkflowScript, preflightWorkflowScript, WorkflowRuntimeError } from "./workflow-runtime.js";
import { parseWorkflowScript } from "./workflow-script.js";
import type {
  JsonValue,
  WorkflowAgentRequest,
  WorkflowRuntimeCallbacks,
  WorkflowRuntimeEvent,
} from "./workflow-types.js";

function script(body: string) {
  return parseWorkflowScript(`export const meta = { name: 'test', description: 'Runtime test' }\n${body}`);
}

async function run(
  body: string,
  callbacks: Partial<WorkflowRuntimeCallbacks> = {},
  options: { argsPresent?: boolean; args?: JsonValue; limits?: Parameters<typeof executeWorkflowScript>[0]["limits"] } = {},
) {
  const events: WorkflowRuntimeEvent[] = [];
  const defaults: WorkflowRuntimeCallbacks = {
    agent: async ({ prompt }) => ({ value: prompt }),
    workflow: async ({ args }) => ({ value: args ?? null }),
    event: (event) => { events.push(event); },
    budget: () => ({ total: 10, knownSpent: 3, complete: true }),
  };
  const result = await executeWorkflowScript({
    script: script(body),
    argsPresent: options.argsPresent ?? false,
    args: options.args,
    generation: 1,
    depth: 0,
    budget: { total: 10, knownSpent: 0, complete: true },
    limits: options.limits,
    signal: new AbortController().signal,
    callbacks: { ...defaults, ...callbacks, event: async (event) => {
      events.push(event);
      await callbacks.event?.(event);
    } },
  });
  return { result, events };
}

{
  const seen: WorkflowAgentRequest[] = [];
  const starts: string[] = [];
  const { result, events } = await run(`
phase('Review')
const mutable = { label: 'before' }
const first = agent('slow', mutable)
mutable.label = 'after'
const parallelRows = await parallel([
  () => first,
  () => agent('fast', { phase: 'Explicit' }),
  () => { throw new Error('boom') },
])
const rows = await pipeline(
  [1, 2],
  value => agent('stage1:' + value),
  (previous, original, index) => [previous, original, index],
)
const child = await workflow('child', { x: args.x })
log('finished')
return { parallelRows, rows, child, spent: budget.spent(), remaining: budget.remaining() }
`, {
    agent: async (request) => {
      seen.push(request);
      starts.push(request.prompt);
      if (request.prompt === "slow" || request.prompt === "stage1:1") await delay(30);
      else await delay(1);
      return { value: request.prompt, budget: { total: 10, knownSpent: 3, complete: true }, replayed: request.prompt === "fast" };
    },
  }, { argsPresent: true, args: { x: 7 } });

  assert.deepEqual(result.result, {
    parallelRows: ["slow", "fast", null],
    rows: [["stage1:1", 1, 0], ["stage1:2", 2, 1]],
    child: { x: 7 },
    spent: 3,
    remaining: 7,
  });
  assert.equal(result.partial, true);
  assert.equal(seen.find(({ prompt }) => prompt === "slow")?.options.label, "before");
  assert.equal(seen.find(({ prompt }) => prompt === "slow")?.phase, "Review");
  assert.equal(seen.find(({ prompt }) => prompt === "slow")?.location?.line, 5);
  assert.equal(seen.find(({ prompt }) => prompt === "fast")?.phase, "Explicit");
  assert(starts.indexOf("stage1:2") < starts.indexOf("stage1:1") + 2, "pipeline items start independently");
  assert(events.some((event) => event.type === "combinator_error" && event.index === 2));
  assert(events.some((event) => event.type === "log" && event.message === "finished"));
  assert(events.some((event) => event.type === "delivery" && event.replayed));
  assert.equal(events.filter((event) => event.type === "budget_observation").length, 2);
}

{
  const result = await executeWorkflowScript({
    script: script(`await agent('live'); return budget.spent()`),
    argsPresent: false,
    generation: 5,
    depth: 0,
    budget: { total: 100, knownSpent: 0, complete: true },
    replay: { budgetObservations: [{ getter: "spent", value: 4 }] },
    signal: new AbortController().signal,
    callbacks: {
      agent: async () => ({ value: "new", budget: { total: 100, knownSpent: 9, complete: true } }),
      workflow: async () => ({ value: null }),
      event: () => undefined,
    },
  });
  assert.equal(result.result, 9, "a live delivery ends replayed budget observations");
}

{
  const absent = await run(`return typeof args`);
  assert.equal(absent.result.result, "undefined");
  const explicitNull = await run(`return args`, {}, { argsPresent: true, args: null });
  assert.equal(explicitNull.result.result, null);
  const omitted = await run(`return;`);
  assert.equal(omitted.result.result, null);
  assert.equal(omitted.result.omittedResult, true);
}

{
  const restricted = await run(`
const blocked = []
for (const operation of [() => Date.now(), () => new Date(), () => new Date(2020, 1), () => Math.random()]) {
  try { operation() } catch { blocked.push(true) }
}
return { process: typeof process, require: typeof require, blocked }
`);
  assert.deepEqual(restricted.result.result, {
    process: "undefined",
    require: "undefined",
    blocked: [true, true, true, true],
  });
  const utc = await run(`return [new Date('2020-01-01T00:00:00.000Z').toISOString(), Date.UTC(2020, 0, 1)]`);
  assert.deepEqual(utc.result.result, ["2020-01-01T00:00:00.000Z", 1577836800000]);
  const constructors = await run(`return [
    Function('return typeof process')(),
    ({}).constructor.constructor('return typeof require')(),
    Function('return typeof globalThis.process')(),
  ]`);
  assert.deepEqual(constructors.result.result, ["undefined", "undefined", "undefined"]);
  const protectedIntrinsics = await run(`
const blocked = []
for (const mutate of [
  () => { Array.prototype.toJSON = () => ['forged'] },
  () => { Promise.all = () => Promise.resolve(['forged']) },
  () => { Object.getOwnPropertyDescriptors = () => ({}) },
]) {
  try { mutate() } catch { blocked.push(true) }
}
return { blocked, normal: await Promise.all([[1, 2]]) }
`);
  assert.deepEqual(protectedIntrinsics.result.result, { blocked: [true, true, true], normal: [[1, 2]] });
}

{
  let calls = 0;
  const invalidOptions = await run(`
const value = await agent('x', { unknown: true }).catch(error => error.code)
return value
`, { agent: async () => { calls += 1; return { value: null }; } });
  assert.equal(calls, 0);
  assert.equal(invalidOptions.result.partial, true);
}

await assert.rejects(
  run(`while (true) {}` , {}, { limits: { guestSliceMs: 10, guestTotalCpuMs: 20 } }),
  (error: unknown) => error instanceof WorkflowRuntimeError && error.code === "SCRIPT_CPU_LIMIT",
);

await preflightWorkflowScript(script(`while (true) {}`), { timeoutMs: 1_000 });
await assert.rejects(
  preflightWorkflowScript(script(`using value = null\nreturn value`)),
  (error: unknown) => error instanceof WorkflowRuntimeError && error.code === "WORKFLOW_SYNTAX_ERROR",
);

{
  let releaseDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => { releaseDeadline = resolve; });
  const result = await executeWorkflowScript({
    script: script(`await agent('parked'); return 'resumed'`), argsPresent: false,
    generation: 6, depth: 0, budget: { total: null, knownSpent: 0, complete: true },
    limits: { runActiveMs: 10 }, signal: new AbortController().signal,
    callbacks: {
      agent: async () => { await delay(30); return { value: null }; },
      workflow: async () => ({ value: null }), event: () => undefined,
      waitForActiveTimeout: () => deadline,
    },
  });
  releaseDeadline();
  assert.equal(result.result, "resumed", "the manager clock replaces the worker's wall-clock timeout");
}

await assert.rejects(executeWorkflowScript({
  script: script(`await agent('timeout'); return null`), argsPresent: false,
  generation: 7, depth: 0, budget: { total: null, knownSpent: 0, complete: true },
  limits: { runActiveMs: 20 }, signal: new AbortController().signal,
  callbacks: {
    agent: async (_request, context) => await new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    }),
    workflow: async () => ({ value: null }), event: () => undefined,
  },
}), (error: unknown) => error instanceof WorkflowRuntimeError && error.code === "WORKFLOW_TIMEOUT");
await assert.rejects(
  run(`const spin = () => Promise.resolve().then(spin); spin(); await new Promise(() => {})`, {}, {
    limits: { guestSliceMs: 10, guestTotalCpuMs: 20 },
  }),
  (error: unknown) => error instanceof WorkflowRuntimeError && error.code === "SCRIPT_CPU_LIMIT",
);
await assert.rejects(run(`await new Promise(() => {})`), /stalled with no outstanding operations/);
await assert.rejects(
  run(`\nthrow new Error('located')`),
  (error: unknown) => error instanceof WorkflowRuntimeError && error.location?.line === 3,
);

await assert.rejects(
  run(`const value = {}; Object.defineProperty(value, 'secret', { get() { throw new Error('getter ran') } }); return value`),
  /accessors/,
);
await assert.rejects(
  run(`const value = {}; value.self = value; return value`),
  /cycles/,
);

{
  let getterCalled = false;
  const args = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() { getterCalled = true; return "no"; },
  });
  await assert.rejects(executeWorkflowScript({
    script: script(`return args`), argsPresent: true, args: args as JsonValue,
    generation: 3, depth: 0, budget: { total: null, knownSpent: 0, complete: true },
    signal: new AbortController().signal,
    callbacks: {
      agent: async () => ({ value: null }), workflow: async () => ({ value: null }), event: () => undefined,
    },
  }), /accessors/);
  assert.equal(getterCalled, false);
}

{
  const controller = new AbortController();
  const execution = executeWorkflowScript({
    script: script(`await agent('wait'); return null`), argsPresent: false,
    generation: 4, depth: 0, budget: { total: null, knownSpent: 0, complete: true },
    signal: controller.signal,
    callbacks: {
      agent: async (_request, context) => await new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      }),
      workflow: async () => ({ value: null }), event: () => undefined,
    },
  });
  await delay(10);
  controller.abort();
  await assert.rejects(execution, (error: unknown) =>
    error instanceof WorkflowRuntimeError && error.code === "WORKFLOW_STOPPED");
}

{
  let childFinished = false;
  const started = performance.now();
  const drained = await run(`agent('fire-and-forget'); return 'body-done'`, {
    agent: async () => {
      await delay(30);
      childFinished = true;
      return { value: "child-done" };
    },
  });
  assert.equal(drained.result.result, "body-done");
  assert.equal(childFinished, true);
  assert(performance.now() - started >= 25);
}

{
  const reviews = new Map<string, JsonValue>([
    ["Review a.ts", { findings: ["bad branch"] }],
    ["Review b.ts", { findings: [] }],
    ["Verify bad branch in a.ts", { confirmed: true, evidence: "line 4" }],
  ]);
  const example = await run(`
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'], additionalProperties: false }
const VERDICT = { type: 'object', properties: { confirmed: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['confirmed', 'evidence'], additionalProperties: false }
const rows = await pipeline(
  args.files,
  file => agent('Review ' + file, { phase: 'Review', label: file, schema: FINDINGS }),
  async (review, file) => {
    if (review === null) return { file, status: 'review_failed' }
    const verdicts = await parallel(review.findings.map(finding => () =>
      agent('Verify ' + finding + ' in ' + file, { phase: 'Verify', label: file, schema: VERDICT })
        .then(verdict => ({ finding, verdict }))
    ))
    return { file, status: 'reviewed', verdicts }
  },
)
return { rows }
`, {
    agent: async ({ prompt, options }) => {
      assert(options.schema);
      return { value: reviews.get(prompt) ?? null };
    },
  }, { argsPresent: true, args: { files: ["a.ts", "b.ts"] } });
  assert.deepEqual(example.result.result, { rows: [
    { file: "a.ts", status: "reviewed", verdicts: [{ finding: "bad branch", verdict: { confirmed: true, evidence: "line 4" } }] },
    { file: "b.ts", status: "reviewed", verdicts: [] },
  ] });
}

await assert.rejects(
  run(`log('12345'); return null`, {}, { limits: { logMessageBytes: 4 } }),
  (error: unknown) => error instanceof WorkflowRuntimeError && error.code === "LOG_LIMIT",
);

{
  const events: WorkflowRuntimeEvent[] = [];
  const result = await executeWorkflowScript({
    script: script(`return [budget.spent(), budget.remaining()]`),
    argsPresent: false,
    generation: 2,
    depth: 0,
    budget: { total: 100, knownSpent: 99, complete: true },
    replay: { budgetObservations: [
      { getter: "spent", value: 4 },
      { getter: "remaining", value: 6 },
    ] },
    signal: new AbortController().signal,
    callbacks: {
      agent: async () => ({ value: null }),
      workflow: async () => ({ value: null }),
      event: (event) => { events.push(event); },
    },
  });
  assert.deepEqual(result.result, [4, 6]);
  assert.equal(events.filter((event) => event.type === "budget_observation").length, 2);
}
