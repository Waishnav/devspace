import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Result } from "better-result";
import { AgentConflictError, AgentProviderCancelledError } from "./local-agent-errors.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentStore, type LocalAgentTurnRecord } from "./local-agent-store.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRunInput, LocalAgentRuntime } from "./local-agent-runtime.js";
import { WorkflowManager } from "./workflow-manager.js";
import { WorkflowStore } from "./workflow-store.js";
import type { runWorkflowScript } from "./workflow-runner.js";
import { WorkflowError } from "./workflow-types.js";
import type { ServerConfig } from "./config.js";
import { isManagedWorkflowWorkspace } from "./workflow-workspaces.js";

async function fixture(runner?: typeof runWorkflowScript) {
  const dir = await mkdtemp(join(tmpdir(), "devspace-workflow-"));
  await mkdir(join(dir, "project"));
  const root = await realpath(join(dir, "project"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"], { cwd: root });
  const stateDir = join(dir, "state");
  const config = { stateDir, allowedRoots: [root], worktreeRoot: join(dir, "worktrees") } as ServerConfig;
  const inputs: LocalAgentRunInput[] = [];
  let active = 0;
  let maximum = 0;
  let releaseHold: (() => void) | undefined;
  const runtime: LocalAgentRuntime = {
    provider: "codex", isAlive: () => true, close: async () => {}, releaseSession: async () => {},
    run: async (input, callbacks) => {
      inputs.push(input);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await callbacks?.onSessionId?.(`session_${inputs.length}`);
        if (input.prompt === "commit") {
          await writeFile(join(input.workspaceRoot, "committed.txt"), "preserve this commit");
          execFileSync("git", ["add", "committed.txt"], { cwd: input.workspaceRoot });
          execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Worker change"], { cwd: input.workspaceRoot });
          await writeFile(join(input.workspaceRoot, "untracked.txt"), "preserve this too");
        }
        if (input.prompt === "hold") {
          await new Promise<void>((resolve) => {
            releaseHold = resolve;
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
            if (input.signal?.aborted) resolve();
          });
          if (input.signal?.aborted) return Result.err(new AgentProviderCancelledError({
            code: "PROVIDER_CANCELLED", provider: "codex", operation: "run", retryable: false, message: "Test provider confirmed cancellation.",
          }));
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Result.ok({ provider: "codex" as const, providerSessionId: null, finalResponse: input.prompt.startsWith("Your last response") ? '{"ok":true}' : input.prompt, items: [] });
      } finally { active--; }
    },
  };
  const agents = new LocalAgentManager({
    store: new LocalAgentStore(stateDir), pool: new LocalAgentRuntimePool(), loadProfiles: async () => [],
    subagents: { enabled: true, instructions: "on-demand", providers: [{ id: "codex", enabled: true }] },
    drivers: [{ provider: "codex", runtimeKey: () => "shared", createRuntime: async () => Result.ok(runtime) }],
    allowedRoots: [root],
    authorizeManagedWorkspace: (path, id) => isManagedWorkflowWorkspace(config, path, id),
  });
  const store = new WorkflowStore(stateDir);
  const workflows = new WorkflowManager({
    store, agents, runner, config, loadProfiles: async () => [], allowedRoots: [root],
    subagents: { enabled: true, instructions: "on-demand", providers: [{ id: "codex", enabled: true }] },
  });
  const scope = { workspaceRoot: root };
  return {
    dir, root, inputs, agents, store, workflows, scope, maximum: () => maximum,
    release: () => releaseHold?.(),
    close: async () => { releaseHold?.(); await workflows.close(); await agents.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("real JS pipeline runs in parallel, preserves order and durable turn ownership", async () => {
  const f = await fixture();
  try {
    const run = await f.workflows.run({ ...f.scope, source: `export const meta = {name:'test',concurrency:2};
      return await pipeline(['a','b','c'], value => agent(value,{target:'codex'}), (value,item) => agent(value+item,{target:'codex'}));` });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.deepEqual(done.result, ["aa", "bb", "cc"].map((value) => ({ status: "completed", value })));
    assert.equal(f.maximum(), 2);
    assert.equal(f.workflows.calls(run.id, f.scope).length, 6);
    assert.ok(f.workflows.calls(run.id, f.scope).every((call) => call.turnId && call.agentId && call.status === "completed"));
  } finally { await f.close(); }
});

test("shared daemon capacity bounds simultaneous workflows", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => onAgent(String(i), { target: "codex" })));
    return "done";
  });
  try {
    const source = "export const meta={concurrency:16}; return null;";
    const runs = await Promise.all([f.workflows.run({ ...f.scope, source }), f.workflows.run({ ...f.scope, source })]);
    await Promise.all(runs.map((r) => f.workflows.wait(r.id, f.scope)));
    assert.equal(f.maximum(), 8);
  } finally { await f.close(); }
});

test("cancelling one workflow stops its exact owned turn and preserves another shared-runtime agent", async () => {
  const f = await fixture(async ({ onAgent }) => await onAgent("hold", { target: "codex" }) as string);
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await until(() => f.inputs.length === 1);
    const other = await f.agents.start({ ...f.scope, target: "codex", prompt: "other" });
    assert.ok(other.isOk());
    await f.workflows.cancel(run.id, f.scope);
    assert.equal((await f.workflows.wait(run.id, f.scope)).status, "cancelled");
    const call = f.workflows.call(run.id, 0, f.scope);
    assert.equal(call.status, "cancelled");
    assert.equal(unwrap(f.agents.getTurn(call.agentId, call))?.status, "stopped");
    assert.equal(unwrap(await f.agents.wait([other.value.id], f.scope))[0]?.status, "completed");
  } finally { await f.close(); }
});

test("normal return with unawaited calls cancels children before persisting failure", async () => {
  const f = await fixture(async ({ onAgent }) => {
    void Promise.resolve(onAgent("hold", { target: "codex" })).catch(() => {});
    await until(() => f.inputs.length === 1);
    return "early";
  });
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, "UNAWAITED_CALLS");
    assert.equal(f.agents.activeTurnCount, 0);
  } finally { await f.close(); }
});

test("schema validates before dispatch and one correction runs with reduced authority", async () => {
  const f = await fixture(async ({ onAgent }) => await onAgent("work", {
    target: "codex", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  }) as { ok: boolean });
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;", writeMode: "allowed" });
    assert.deepEqual((await f.workflows.wait(run.id, f.scope)).result, { ok: true });
    assert.deepEqual(f.inputs.map((i) => i.writeMode), ["allowed", "read_only"]);
    assert.equal(f.workflows.calls(run.id, f.scope).length, 1);
  } finally { await f.close(); }
  const invalid = await fixture(async ({ onAgent }) => await onAgent("never", { target: "codex", schema: { type: "nonsense" } }) as null);
  try {
    const run = await invalid.workflows.run({ ...invalid.scope, source: "return null;" });
    assert.equal((await invalid.workflows.wait(run.id, invalid.scope)).error?.code, "INVALID_SCHEMA");
    assert.equal(invalid.inputs.length, 0);
  } finally { await invalid.close(); }
});

test("resume reuses only compatible read-only prefix and rejects changed context and active runs", async () => {
  const f = await fixture(async ({ onAgent }) => await onAgent("review", { target: "codex" }) as string);
  try {
    const first = await f.workflows.run({ ...f.scope, source: "return null;" });
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: unknown) => e instanceof WorkflowError && e.code === "WORKFLOW_ACTIVE");
    await f.workflows.wait(first.id, f.scope);
    const resumed = await f.workflows.run({ ...f.scope, resume: first.id });
    await f.workflows.wait(resumed.id, f.scope);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.workflows.call(resumed.id, 0, f.scope).reusedFrom, first.id);
    await writeFile(join(f.root, "changed"), "changed");
    await assert.rejects(f.workflows.run({ ...f.scope, resume: first.id }), (e: unknown) => e instanceof WorkflowError && e.code === "RECOVERY_CONTEXT_CHANGED");
    assert.throws(() => f.workflows.get(first.id, { workspaceRoot: f.dir }), /not in this workspace/);
  } finally { await f.close(); }
});

test("resume rejects staged Git state changes even when worktree files are unchanged", async () => {
  const f = await fixture(async () => null);
  try {
    await writeFile(join(f.root, "staged.txt"), "same content");
    const first = await f.workflows.run({ ...f.scope, source: "return null;" });
    await f.workflows.wait(first.id, f.scope);
    execFileSync("git", ["add", "staged.txt"], { cwd: f.root });
    await assert.rejects(
      f.workflows.run({ ...f.scope, resume: first.id }),
      (error: unknown) => error instanceof WorkflowError && error.code === "RECOVERY_CONTEXT_CHANGED",
    );
  } finally { await f.close(); }
});

test("nested workflow shares capacity at concurrency one and cannot recursively nest", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, ".devspace", "workflows"), { recursive: true });
    await writeFile(join(f.root, ".devspace", "workflows", "child.js"), "return await agent('nested',{target:'codex'});");
    const run = await f.workflows.run({ ...f.scope, source: "export const meta={concurrency:1}; return await workflow('child',{});" });
    assert.equal((await f.workflows.wait(run.id, f.scope)).result, "nested");
    await writeFile(join(f.root, ".devspace", "workflows", "child.js"), "try { return await workflow('child',{}); } catch { return 'ignored'; }");
    const recursive = await f.workflows.run({ ...f.scope, source: "return await workflow('child',{});" });
    assert.equal((await f.workflows.wait(recursive.id, f.scope)).status, "failed");
  } finally { await f.close(); }
});

test("worktree calls share their logical workspace and preserve commits plus dirty files", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await onAgent("commit", { target: "codex", isolation: "worktree", workspace: "implementation" });
    return await onAgent("verify", { target: "codex", workspace: "implementation", writeMode: "read_only" }) as string;
  });
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;", writeMode: "allowed" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const [implementation, verify] = f.workflows.calls(run.id, f.scope);
    assert.equal(implementation!.workspaceRoot, verify!.workspaceRoot);
    assert.notEqual(implementation!.workspaceRoot, f.root);
    assert.equal(await readFile(join(implementation!.workspaceRoot, "untracked.txt"), "utf8"), "preserve this too");
    assert.equal(execFileSync("git", ["show", "HEAD:committed.txt"], { cwd: implementation!.workspaceRoot, encoding: "utf8" }), "preserve this commit");
    await assert.rejects(readFile(join(f.root, "committed.txt")));
    await assert.rejects(f.workflows.run({ ...f.scope, resume: run.id }), (error: unknown) => error instanceof WorkflowError && error.code === "RECOVERY_REQUIRED");
  } finally { await f.close(); }
});

test("restart reconciliation preserves durable ownership without dispatching interrupted calls", async () => {
  const f = await fixture(async () => "done");
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await f.workflows.wait(run.id, f.scope);
    f.store.addCall({ runId: run.id, index: 0, agentId: "agt_interrupted", status: "queued", prompt: "pending",
      options: { target: "codex", writeMode: "read_only" }, fingerprint: "old", ...f.scope, createdAt: "now", updatedAt: "now" });
    const child = unwrap(await f.agents.start({ ...f.scope, agentId: "agt_interrupted", target: "codex", prompt: "done", writeMode: "read_only" }));
    await f.agents.wait([child.id], f.scope);
    f.store.update(run.id, { status: "running" });
    f.workflows.reconcile();
    assert.equal(f.workflows.get(run.id, f.scope).status, "interrupted");
    const recovered = f.workflows.call(run.id, 0, f.scope);
    assert.equal(recovered.agentId, "agt_interrupted");
    assert.ok(recovered.turnId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(f.inputs.length, 1);
  } finally { await f.close(); }
});

test("parallel unnamed isolated calls receive distinct worktrees", async () => {
  const f = await fixture(async ({ onAgent }) => {
    await Promise.all([0, 1].map((i) => onAgent(String(i), { target: "codex", isolation: "worktree" })));
    return "done";
  });
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    const done = await f.workflows.wait(run.id, f.scope);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const calls = f.workflows.calls(run.id, f.scope);
    assert.equal(new Set(calls.map((call) => call.workspaceRoot)).size, 2);
  } finally { await f.close(); }
});

test("shutdown stops retrying unconfirmed provider cancellation and preserves recovery state", async () => {
  const f = await fixture(async ({ onAgent }) => await onAgent("hold", { target: "codex" }) as string);
  const originalGetTurn = f.agents.getTurn.bind(f.agents);
  const originalCancel = f.agents.cancel.bind(f.agents);
  let close: Promise<void> | undefined;
  try {
    const run = await f.workflows.run({ ...f.scope, source: "return null;" });
    await until(() => f.inputs.length === 1);
    await until(() => f.workflows.calls(run.id, f.scope)[0]?.turnId !== undefined);
    const call = f.workflows.call(run.id, 0, f.scope);
    const runningTurn: LocalAgentTurnRecord = {
      id: call.turnId!, agentId: call.agentId, prompt: call.prompt, status: "running", createdAt: "now",
    };
    f.agents.getTurn = () => Result.ok(runningTurn);
    f.agents.cancel = async () => Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT", agentId: call.agentId, operation: "cancel", retryable: true,
      message: "Provider cancellation is unavailable.",
    }));
    close = f.workflows.close();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("workflow close timed out")), 2_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const reopened = new WorkflowStore(join(f.dir, "state"));
    try {
      assert.equal(reopened.get(run.id)?.status, "stopping");
      assert.equal(reopened.get(run.id)?.error?.code, "RECOVERY_REQUIRED");
    } finally { reopened.close(); }
  } finally {
    f.agents.getTurn = originalGetTurn;
    f.agents.cancel = originalCancel;
    f.release();
    await close?.catch(() => {});
    await f.agents.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function unwrap<T, E>(result: import("better-result").Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
