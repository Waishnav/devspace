import assert from "node:assert/strict";
import { parseWorkflowScript, WorkflowScriptError } from "./workflow-script.js";
import { createStubBudget } from "./workflow-types.js";
import {
  runWorkflowSandbox,
  WorkflowDeterminismError,
  type WorkflowSandboxApi,
} from "./workflow-sandbox.js";

{
  const parsed = parseWorkflowScript(`
export const meta = {
  name: 'fanout-review',
  description: 'Two reviewers',
  phases: [{ title: 'Review', detail: 'parallel' }],
  defaultProvider: 'codex',
  concurrency: 4,
}

return { ok: true, name: meta.name }
`);
  assert.equal(parsed.meta.name, "fanout-review");
  assert.equal(parsed.meta.description, "Two reviewers");
  assert.equal(parsed.meta.defaultProvider, "codex");
  assert.equal(parsed.meta.concurrency, 4);
  assert.deepEqual(parsed.meta.phases, [{ title: "Review", detail: "parallel" }]);
  assert.match(parsed.scriptHash, /^[a-f0-9]{64}$/);
}

{
  assert.throws(
    () => parseWorkflowScript(`const x = 1; export const meta = { name: 'a', description: 'b' }`),
    (error: unknown) =>
      error instanceof WorkflowScriptError &&
      error.kind === "meta" &&
      /first statement/.test(error.message),
  );
}

{
  assert.throws(
    () =>
      parseWorkflowScript(`
export const meta = {
  name: 'bad',
  description: 'x',
  concurrency: Math.max(1, 2),
}
`),
    (error: unknown) => error instanceof WorkflowScriptError && error.kind === "meta",
  );
}

{
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'Bad_Name', description: 'x' }`),
    /meta\.name must match/,
  );
}

{
  assert.throws(
    () => parseWorkflowScript(`export const meta = { description: 'only' }`),
    /meta\.name is required/,
  );
}

{
  // Leading comments OK
  const parsed = parseWorkflowScript(`// header
/* block */
export const meta = { name: 'ok', description: 'd' }
return 1
`);
  assert.equal(parsed.meta.name, "ok");
}

async function runBody(source: string): Promise<unknown> {
  const parsed = parseWorkflowScript(source);
  const logs: string[] = [];
  return runWorkflowSandbox({
    parsed,
    api: {
      agent: async () => "agent-result",
      parallel: async (...args: unknown[]) => {
        const thunks = args[0] as Array<() => Promise<unknown>>;
        return Promise.all(thunks.map((t) => t().catch(() => null)));
      },
      pipeline: async (...args: unknown[]) => args[0],
      phase: () => {},
      log: (msg: unknown) => {
        logs.push(String(msg));
      },
      args: { n: 1 },
      budget: createStubBudget(),
      workflow: async () => null,
      meta: parsed.meta,
    } as WorkflowSandboxApi,
  });
}

{
  const result = await runBody(`
export const meta = { name: 'ret', description: 'd' }
phase('A')
log('hi ' + args.n)
return { v: 1 + 1, fromAgent: await agent('p') }
`);
  assert.deepEqual(result, { v: 2, fromAgent: "agent-result" });
}

{
  await assert.rejects(
    () =>
      runBody(`
export const meta = { name: 'now', description: 'd' }
return Date.now()
`),
    (error: unknown) =>
      error instanceof WorkflowDeterminismError && /Date\.now/.test(error.message),
  );
}

{
  await assert.rejects(
    () =>
      runBody(`
export const meta = { name: 'rand', description: 'd' }
return Math.random()
`),
    WorkflowDeterminismError,
  );
}

{
  await assert.rejects(
    () =>
      runBody(`
export const meta = { name: 'date', description: 'd' }
return new Date()
`),
    WorkflowDeterminismError,
  );
}

{
  // Fixed Date is OK
  const result = await runBody(`
export const meta = { name: 'fixed-date', description: 'd' }
return new Date('2020-01-01T00:00:00.000Z').toISOString()
`);
  assert.equal(result, "2020-01-01T00:00:00.000Z");
}

{
  // No process/require
  await assert.rejects(
    () =>
      runBody(`
export const meta = { name: 'proc', description: 'd' }
return process.pid
`),
    /process is not defined|ReferenceError/,
  );
}

console.log("workflow-script.test.ts: ok");
