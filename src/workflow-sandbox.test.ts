import assert from "node:assert/strict";
import { parseWorkflowScript } from "./workflow-script.js";
import {
  createStubBudget,
  type WorkflowMeta,
} from "./workflow-types.js";
import type { WorkflowSandboxApi } from "./workflow-sandbox.js";
import { runWorkflowSandbox, WorkflowDeterminismError } from "./workflow-sandbox.js";

function api(meta: WorkflowMeta, logs?: string[]): WorkflowSandboxApi {
  return {
    agent: async () => "",
    parallel: async () => [],
    pipeline: async () => [],
    phase: () => {},
    log: (msg: unknown) => {
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

console.log("workflow-sandbox.test.ts: ok");
