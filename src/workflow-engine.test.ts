import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { executeWorkflow } from "./workflow-engine.js";
import {
  createWorkflowApi,
  WorkflowEngineError,
  WorkflowSemaphore,
  getCurrentWorkflowPhase,
  type WorkflowProviderRunInput,
  type CreateAgentWorktree,
} from "./workflow-api.js";
import { createStubBudget } from "./workflow-types.js";

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------
{
  const sem = new WorkflowSemaphore(2);
  let concurrent = 0;
  let maxConcurrent = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      await sem.acquire();
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      sem.release();
    }),
  );
  assert.equal(maxConcurrent, 2);
}

// ---------------------------------------------------------------------------
// parallel → null on throw; barrier
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-engine-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "par",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const order: string[] = [];
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "par", description: "d" },
    args: undefined,
    concurrency: 4,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async (input) => {
      order.push(`start:${input.prompt}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${input.prompt}`);
      if (input.prompt === "fail") throw new Error("boom");
      return { finalResponse: `ok:${input.prompt}` };
    },
  });

  const results = await api.parallel([
    () => api.agent("a"),
    () => api.agent("fail"),
    () => api.agent("b"),
  ]);
  assert.deepEqual(results, ["ok:a", null, "ok:b"]);
  assert.equal(api.getCallCount(), 3);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// pipeline — no barrier across items (item B can finish stage2 before A stage1 ends)
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-pipe-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "pipe",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const events: string[] = [];
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "pipe", description: "d" },
    args: undefined,
    concurrency: 4,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async () => ({ finalResponse: "x" }),
  });

  const result = await api.pipeline(
    ["slow", "fast"],
    async (item: unknown) => {
      events.push(`s1:${item}:start`);
      await new Promise((r) => setTimeout(r, item === "slow" ? 40 : 5));
      events.push(`s1:${item}:end`);
      return `${item}-1`;
    },
    async (prev: unknown, item: unknown) => {
      events.push(`s2:${item}:${prev}`);
      return `${prev}-2`;
    },
  );

  assert.deepEqual(result, ["slow-1-2", "fast-1-2"]);
  // fast finishes stage1 before slow does
  const fastEnd = events.indexOf("s1:fast:end");
  const slowEnd = events.indexOf("s1:slow:end");
  assert.ok(fastEnd >= 0 && slowEnd >= 0 && fastEnd < slowEnd);
  // fast may enter stage2 before slow finishes stage1
  const fastS2 = events.indexOf("s2:fast:fast-1");
  assert.ok(fastS2 >= 0 && fastS2 < slowEnd);

  // throw → null for that item
  const withNull = await api.pipeline(
    [1, 2],
    async (n: unknown) => {
      if (n === 2) throw new Error("nope");
      return n;
    },
  );
  assert.deepEqual(withNull, [1, null]);

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// phase ALS — concurrent chains keep separate phases for agent()
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-phase-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "phase",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const seen: Array<{ prompt: string; phase?: string }> = [];
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "phase", description: "d" },
    args: undefined,
    concurrency: 4,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async (input: WorkflowProviderRunInput) => {
      seen.push({ prompt: input.prompt, phase: input.phase });
      await new Promise((r) => setTimeout(r, 15));
      return { finalResponse: "ok" };
    },
  });

  await api.parallel([
    async () => {
      api.phase("A");
      assert.equal(getCurrentWorkflowPhase(), "A");
      return api.agent("from-a");
    },
    async () => {
      api.phase("B");
      assert.equal(getCurrentWorkflowPhase(), "B");
      return api.agent("from-b");
    },
  ]);

  const a = seen.find((s) => s.prompt === "from-a");
  const b = seen.find((s) => s.prompt === "from-b");
  assert.equal(a?.phase, "A");
  assert.equal(b?.phase, "B");

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// isolation: worktree uses createWorktree path as cwd
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-iso-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "iso",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const worktrees: string[] = [];
  const createWorktree: CreateAgentWorktree = async ({ callIndex }) => {
    const path = join(dir, `wt-${callIndex}`);
    await mkdir(path, { recursive: true });
    worktrees.push(path);
    return {
      path,
      finalize: async () => ({ dirty: false, removed: true }),
    };
  };
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "iso", description: "d" },
    args: undefined,
    concurrency: 2,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    createWorktree,
    runProvider: async (input) => {
      assert.equal(input.workspace, worktrees[0]);
      return { finalResponse: "in-wt" };
    },
  });

  const out = await api.agent("do", { isolation: "worktree", label: "iso" });
  assert.equal(out, "in-wt");
  const calls = store.listAgentCalls(run.id);
  assert.equal(calls[0]?.isolation, "worktree");
  assert.equal(calls[0]?.worktreePath, worktrees[0]);

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// provider resolve order + no writeMode
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-prov-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "prov",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const used: string[] = [];
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "prov", description: "d", defaultProvider: "claude" },
    args: undefined,
    concurrency: 1,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex", "claude"],
    runProvider: async (input) => {
      used.push(input.provider);
      return { finalResponse: input.provider };
    },
  });
  assert.equal(await api.agent("x"), "claude");
  assert.equal(await api.agent("y", { provider: "codex" }), "codex");
  await assert.rejects(
    async () => api.agent("z", { writeMode: "allowed" } as never),
    /writeMode is not supported/,
  );
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// schema retry: native schema only on first attempt + provider session reuse
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-schema-retry-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "schema-retry",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const calls: WorkflowProviderRunInput[] = [];
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "schema-retry", description: "d" },
    args: undefined,
    concurrency: 1,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        return {
          finalResponse: '{"n":"bad"}',
          structured: { n: "bad" },
          providerSessionId: "sess-1",
        };
      }
      return { finalResponse: '{"n":2}', providerSessionId: "sess-1" };
    },
  });

  const out = await api.agent("give n", {
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    },
  });
  assert.deepEqual(out, { n: 2 });
  assert.ok(calls[0]?.schema);
  assert.equal(calls[0]?.providerSessionId, undefined);
  assert.equal(calls[1]?.schema, undefined);
  assert.equal(calls[1]?.providerSessionId, "sess-1");

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// executeWorkflow end-to-end with sandbox + nest depth
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-exec-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "exec",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });

  const childPath = join(dir, "child.js");
  await writeFile(
    childPath,
    `
export const meta = { name: 'child', description: 'nested' }
return await agent('nested-prompt')
`,
  );

  const prompts: string[] = [];
  const { result, callCount } = await executeWorkflow({
    source: `
export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent-prompt')
const nested = await workflow({ scriptPath: ${JSON.stringify(childPath)} })
return { a, nested }
`,
    runId: run.id,
    journal: store,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async (input) => {
      prompts.push(input.prompt);
      return { finalResponse: `R:${input.prompt}` };
    },
    resolveNestedSource: async (ref) => {
      if (typeof ref === "object" && ref.scriptPath) {
        const { readFile } = await import("node:fs/promises");
        return readFile(ref.scriptPath, "utf8");
      }
      throw new Error("unknown nest ref");
    },
  });

  assert.deepEqual(result, {
    a: "R:parent-prompt",
    nested: "R:nested-prompt",
  });
  assert.equal(callCount, 2);
  assert.deepEqual(prompts, ["parent-prompt", "nested-prompt"]);

  // depth 2 must fail
  await assert.rejects(
    () =>
      executeWorkflow({
        source: `
export const meta = { name: 'deep', description: 'd' }
return await workflow({ scriptPath: ${JSON.stringify(childPath)} }).then(async () => {
  // child tries to nest again — child script:
  return 1
})
`,
        runId: run.id,
        journal: store,
        workspaceRoot: dir,
        enabledProviders: ["codex"],
        runProvider: async () => ({ finalResponse: "x" }),
        resolveNestedSource: async () => `
export const meta = { name: 'mid', description: 'm' }
return await workflow({ scriptPath: 'x' })
`,
      }),
    (error: unknown) =>
      error instanceof WorkflowEngineError && error.kind === "nest_depth",
  );

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// cancel via signal
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "wf-cancel-"));
  const store = new WorkflowStore(dir);
  const run = store.createRun({
    name: "cancel",
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot: dir,
  });
  const ac = new AbortController();
  const api = createWorkflowApi({
    runId: run.id,
    journal: store,
    meta: { name: "cancel", description: "d" },
    args: undefined,
    concurrency: 1,
    signal: ac.signal,
    workspaceRoot: dir,
    enabledProviders: ["codex"],
    runProvider: async () => {
      ac.abort();
      return { finalResponse: "late" };
    },
  });
  // abort before agent
  ac.abort();
  await assert.rejects(async () => api.agent("x"), WorkflowEngineError);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

void createStubBudget;
console.log("workflow-engine.test.ts: ok");
