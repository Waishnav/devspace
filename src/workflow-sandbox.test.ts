import assert from "node:assert/strict";
import { parseWorkflowScript } from "./workflow-script.js";
import { WorkflowEngineError } from "./workflow-api.js";
import {
  createStubBudget,
  type WorkflowMeta,
} from "./workflow-types.js";
import type { WorkflowSandboxApi } from "./workflow-sandbox.js";
import { runWorkflowSandbox, WorkflowDeterminismError } from "./workflow-sandbox.js";

function api(
  meta: WorkflowMeta,
  logs?: string[],
  hooks?: {
    agent?: WorkflowSandboxApi["agent"];
    phaseTitles?: string[];
  },
): WorkflowSandboxApi {
  return {
    agent: hooks?.agent ?? (async () => ""),
    parallel: async () => [],
    pipeline: async () => [],
    phase: (title: string) => {
      hooks?.phaseTitles?.push(title);
    },
    log: (msg: unknown) => {
      if (msg && typeof msg === "object" && !Array.isArray(msg) && "message" in msg) {
        logs?.push(String((msg as { message: unknown }).message));
        return;
      }
      logs?.push(String(msg));
    },
    args: undefined as unknown,
    budget: createStubBudget(),
    workflow: async () => null,
    meta,
  } as unknown as WorkflowSandboxApi;
}

{
  const logs: string[] = [];
  const parsed = parseWorkflowScript(`
export const meta = { name: 'console-test', description: 'd' }
console.log('a', { b: 1 })
console.warn('w')
return 'ok'
`);
  const result = await runWorkflowSandbox({ parsed, api: api(parsed.meta, logs) });
  assert.equal(result, "ok");
  assert.equal(logs[0], 'a {"b":1}');
  assert.equal(logs[1], "w");
}

{
  const parsed = parseWorkflowScript(`
export const meta = { name: 'math-abs-ok', description: 'd' }
return Math.abs(-3)
`);
  const abs = await runWorkflowSandbox({ parsed, api: api(parsed.meta) });
  assert.equal(abs, 3);
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'fetch-ban', description: 'd' }
return fetch('https://example.com')
`),
        api: api({ name: "fetch-ban", description: "d" }),
      }),
    /fetch is not defined|ReferenceError/,
  );
}

{
  const parsed = parseWorkflowScript(`
export const meta = { name: 'budget', description: 'd' }
return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() }
`);
  const budgetResult = await runWorkflowSandbox({ parsed, api: api(parsed.meta) });
  assert.deepEqual(budgetResult, { total: null, spent: 0, remaining: Infinity });
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'rnd', description: 'd' }
return Math.random()
`),
        api: api({ name: "rnd", description: "d" }),
      }),
    (error: unknown) =>
      error instanceof WorkflowDeterminismError && /Math\.random/.test(error.message),
  );
}

{
  const started = Date.now();
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'sync-loop', description: 'd' }
while (true) {}
`),
        api: api({ name: "sync-loop", description: "d" }),
        timeoutMs: 100,
      }),
    /exceeded host timeout/,
  );
  assert.ok(Date.now() - started < 5_000, "synchronous loop should be externally terminated");

  const followup = parseWorkflowScript(`
export const meta = { name: 'after-loop', description: 'd' }
return 'still-alive'
`);
  assert.equal(
    await runWorkflowSandbox({ parsed: followup, api: api(followup.meta) }),
    "still-alive",
  );
}

{
  const controller = new AbortController();
  const running = runWorkflowSandbox({
    parsed: parseWorkflowScript(`
export const meta = { name: 'abort-loop', description: 'd' }
while (true) {}
`),
    api: api({ name: "abort-loop", description: "d" }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    () => running,
    (error: unknown) =>
      error instanceof WorkflowEngineError && error.kind === "cancelled",
  );
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'date-constructor-ban', description: 'd' }
return new Date(0).constructor.now()
`),
        api: api({ name: "date-constructor-ban", description: "d" }),
      }),
    (error: unknown) =>
      error instanceof WorkflowDeterminismError && /Date\.now/.test(error.message),
  );
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'constructor-escape', description: 'd' }
return Object.constructor('return process.version')()
`),
        api: api({ name: "constructor-escape", description: "d" }),
      }),
    /process is not defined/,
  );
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'promise-realm-escape', description: 'd' }
const pending = agent('x')
return pending.constructor.constructor('return process')()
`),
        api: api({ name: "promise-realm-escape", description: "d" }),
      }),
    /process is not defined/,
  );
}

{
  const hostApi = api({ name: "result-realm-escape", description: "d" });
  hostApi.agent = async () => ({ ok: true }) as never;
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'result-realm-escape', description: 'd' }
const value = await agent('x')
return value.constructor.constructor('return process')()
`),
        api: hostApi,
      }),
    /process is not defined/,
  );
}

{
  const hostApi = api({ name: "error-realm-escape", description: "d" });
  hostApi.agent = async () => {
    throw new WorkflowEngineError("internal", "boom");
  };
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'error-realm-escape', description: 'd' }
try {
  await agent('x')
} catch (error) {
  return error.constructor.constructor('return process')()
}
`),
        api: hostApi,
      }),
    /process is not defined/,
  );
}

{
  await assert.rejects(
    () =>
      runWorkflowSandbox({
        parsed: parseWorkflowScript(`
export const meta = { name: 'api-constructor-escape', description: 'd' }
return agent.constructor('return process.version')()
`),
        api: api({ name: "api-constructor-escape", description: "d" }),
      }),
    /process is not defined/,
  );
}

// Child-owned phase ALS: concurrent chains inject distinct opts.phase over IPC.
{
  const seen: Array<{ prompt: string; phase?: string }> = [];
  const phaseTitles: string[] = [];
  const hostApi = api(
    { name: "phase-ipc", description: "d" },
    undefined,
    {
      phaseTitles,
      agent: async (prompt: string, opts?: { phase?: string }) => {
        seen.push({ prompt, phase: opts?.phase });
        await new Promise((r) => setTimeout(r, 20));
        return `ok:${prompt}`;
      },
    },
  );
  // Host parallel is unused; child implements parallel. Agent is bridged.
  const result = await runWorkflowSandbox({
    parsed: parseWorkflowScript(`
export const meta = { name: 'phase-ipc', description: 'd' }
return await parallel([
  async () => {
    phase('A')
    log('in-a')
    return await agent('from-a')
  },
  async () => {
    phase('B')
    log('in-b')
    return await agent('from-b')
  },
])
`),
    api: hostApi,
  });
  assert.deepEqual(result, ["ok:from-a", "ok:from-b"]);
  assert.deepEqual(new Set(phaseTitles), new Set(["A", "B"]));
  const a = seen.find((row) => row.prompt === "from-a");
  const b = seen.find((row) => row.prompt === "from-b");
  assert.equal(a?.phase, "A");
  assert.equal(b?.phase, "B");
}

console.log("workflow-sandbox.test.ts: ok");
