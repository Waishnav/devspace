import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Result, type Result as BetterResult } from "better-result";
import { defaultWorkflowsConfig } from "./workflow-config.js";
import { openDatabase } from "./db/client.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { AgentProviderCancelledError, AgentProviderExecutionError, type AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentCapabilities,
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunControl,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createWorkflowManager } from "./workflow-manager.js";
import type { WorkflowReply, WorkflowRequest, WorkflowScope } from "./workflow-protocol.js";
import { WorkflowRegistry } from "./workflow-registry.js";
import { WorkflowStore } from "./workflow-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workflow-manager-"));
const stateDir = join(root, "state");
const scope: WorkflowScope = { workspaceId: "ws_test", workspaceRoot: root };
const database = openDatabase(stateDir);
const agentStore = new LocalAgentStore(database);
const calls: LocalAgentRunInput[] = [];
const promptCalls = new Map<string, number>();
const capabilities: LocalAgentCapabilities = {
  cancellation: "turn", structuredOutput: "validated_text", usage: "final",
  correctionAuthority: "no_tools", permissionRequests: "preconfigured", progress: "text",
};

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  async run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
    control?: LocalAgentRunControl,
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    calls.push(input);
    promptCalls.set(input.prompt, (promptCalls.get(input.prompt) ?? 0) + 1);
    if (control?.signal.aborted) throw control.signal.reason;
    if (input.prompt === "hold" || input.prompt === "hold-stop" || input.prompt.startsWith("hold-failure-")
      || (input.prompt === "hold-restart" && promptCalls.get(input.prompt) === 1)) {
      await new Promise<void>((resolveAbort) => control?.signal.addEventListener("abort", () => resolveAbort(), { once: true }));
      return Result.err(new AgentProviderCancelledError({ code: "PROVIDER_CANCELLED", provider: "codex",
        operation: "run", retryable: false, message: "cancelled" }));
    }
    if (input.prompt === "rate-once" && promptCalls.get(input.prompt) === 1) {
      return Result.err(new AgentProviderExecutionError({ code: "PROVIDER_EXECUTION_ERROR", provider: "codex",
        operation: "run", retryable: true, message: "limited", retryAfterMs: 500, executionUncertain: false }));
    }
    if (input.prompt === "slow" || input.prompt === "slow-restart") await delay(30);
    await callbacks?.onSessionId?.(`session_${input.attemptId}`);
    await callbacks?.onProgress?.({ type: "text", text: "working" });
    const finalResponse = input.prompt.startsWith("Return only corrected JSON")
      ? JSON.stringify({ ok: true })
      : input.outputSchema ? "not json" : input.prompt === "large-output" ? "x".repeat(70_000)
        : input.prompt === "slow-restart"
        ? `done:${input.prompt}:${promptCalls.get(input.prompt)}` : `done:${input.prompt}`;
    await callbacks?.onUsage?.({ attemptId: input.attemptId!, sequence: 1, outputTokens: 3, final: true });
    return Result.ok({ provider: "codex", providerSessionId: `session_${input.attemptId}`,
      finalResponse, items: [], usage: { attemptId: input.attemptId!, sequence: 1, outputTokens: 3, final: true } });
  }
  releaseSession(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  isAlive(): boolean { return true; }
}

const driver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: ({ agentId }) => agentId,
  createRuntime: async () => Result.ok(new FakeRuntime()),
  capabilities: () => capabilities,
};
const profile: LocalAgentProfile = {
  name: "reviewer", description: "Reviewer", provider: "codex",
  filePath: join(root, "reviewer.md"), body: "", disabled: false, writeMode: "read_only",
};
const subagents: SubagentsConfig = {
  enabled: true, instructions: "on-demand", providers: [{ id: "codex", enabled: true }],
};
const agents = new LocalAgentManager({
  store: agentStore, drivers: [driver], pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile], subagents,
  validateWorkspaceScope: ({ workspaceRoot }) => workspaceRoot,
});
const workflowStore = new WorkflowStore(database);
class CountingWorkflowRegistry extends WorkflowRegistry {
  discoveries = 0;
  override async discover(workspaceRoot: string) {
    this.discoveries += 1;
    return super.discover(workspaceRoot);
  }
}
const workflowRegistry = new CountingWorkflowRegistry();
let worktrees = 0;
const workflowsConfig = { ...defaultWorkflowsConfig(), enabled: true, defaultAgentType: "reviewer", maxConcurrentRuns: 1 };
const manager = createWorkflowManager({
  stateDir, agents, agentStore, store: workflowStore,
  config: workflowsConfig,
  registry: workflowRegistry,
  validateScope: async (candidate) => {
    assert.deepEqual(candidate, scope);
    return candidate;
  },
  createWorktree: async () => ({
    workspaceId: `ws_worktree_${++worktrees}`, workspaceRoot: root, baseSha: "abc123",
  }),
  inspectWorktree: async () => ({ changed: true }),
});

try {
  const invalidGrammar = await manager.request({ operation: "run", scope, input: { script: `
export const meta = { name: 'invalid-grammar', description: 'QuickJS grammar preflight' }
using value = null
return value` } });
  assert.equal(invalidGrammar.ok, false);
  if (!invalidGrammar.ok) assert.equal(invalidGrammar.error.code, "WORKFLOW_SYNTAX_ERROR");
  assert.equal(workflowStore.listRuns(scope.workspaceId, 10).length, 0,
    "QuickJS grammar failures reject before a durable run is created");

  const first = await run(`
export const meta = { name: 'structured', description: 'Structured retry' }
return await agent('inspect', { schema: {
  type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
} })`);
  const firstSnapshot = await terminal(first.runId);
  assert.equal(firstSnapshot.state, "completed", JSON.stringify(firstSnapshot));
  assert.deepEqual(firstSnapshot.result, { ok: true });
  assert.equal(firstSnapshot.usage.knownOutputTokens, 6);
  const firstSteps = workflowStore.listSteps(first.runId);
  assert.equal(firstSteps.length, 1);
  assert.equal(workflowStore.listAttempts(firstSteps[0]!.id).length, 2);
  assert(firstSteps[0]!.deliverySequence);
  const exportDir = join(root, ".devspace", "workflows", "runs", first.runId);
  assert.equal(JSON.parse(await readFile(join(exportDir, "result.json"), "utf8")).ok, true);
  assert.match(await readFile(join(exportDir, "journal.jsonl"), "utf8"), /"type":"run_state"/);
  const journalMtime = (await stat(join(exportDir, "journal.jsonl"))).mtimeMs;
  await delay(20);
  assert.equal((await manager.request({ operation: "get", scope, input: { runId: first.runId } })).ok, true);
  assert.equal((await stat(join(exportDir, "journal.jsonl"))).mtimeMs, journalMtime,
    "terminal observations reuse the exported journal");

  const callCount = calls.length;
  const resumed = await run(`
export const meta = { name: 'structured', description: 'Structured retry' }
const value = await agent('inspect', { schema: {
  type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
} })
return { value }`, { resumeFromRunId: first.runId });
  const resumedSnapshot = await terminal(resumed.runId);
  assert.equal(resumedSnapshot.state, "completed");
  assert.deepEqual(resumedSnapshot.result, { value: { ok: true } });
  assert.equal(calls.length, callCount, "matching replay does not dispatch a provider turn");
  assert.equal(workflowStore.listSteps(resumed.runId)[0]?.state, "cached");

  const logged = await run(`
export const meta = { name: 'logged', description: 'Replay logs' }
phase('Review')
log('same log')
return await agent('logged')`);
  assert.equal((await terminal(logged.runId)).result, "done:logged");
  const loggedCallCount = calls.length;
  const loggedReplay = await run(`
export const meta = { name: 'logged', description: 'Replay logs' }
phase('Review')
log('same log')
return await agent('logged')`, { resumeFromRunId: logged.runId });
  const loggedReplaySnapshot = await terminal(loggedReplay.runId);
  assert.equal(loggedReplaySnapshot.resumedFromRunId, logged.runId);
  assert.equal(loggedReplaySnapshot.events.some((event: any) => event.type === "log" || event.type === "phase"), false,
    "matching replay events link to the source run instead of duplicating user-visible logs");
  assert.equal(calls.length, loggedCallCount);
  const changedLog = await run(`
export const meta = { name: 'logged', description: 'Replay logs' }
phase('Review')
log('new log')
return await agent('logged')`, { resumeFromRunId: loggedReplay.runId });
  assert.equal((await terminal(changedLog.runId)).state, "completed");
  assert.equal(workflowStore.listEvents(changedLog.runId).some((event) =>
    event.type === "log" && event.payload.message === "new log"), true);
  assert.equal(calls.length, loggedCallCount + 1, "a new replay log establishes the live boundary");

  const observedBudget = await run(`
export const meta = { name: 'budgeted', description: 'Budget observations' }
const before = budget.spent()
await agent('budgeted')
return [before, budget.spent()]`);
  assert.deepEqual((await terminal(observedBudget.runId)).result, [0, 3]);
  const budgetCallCount = calls.length;
  const editedBudget = await run(`
export const meta = { name: 'budgeted', description: 'Budget observations' }
await agent('budgeted')
return budget.spent()`, { resumeFromRunId: observedBudget.runId });
  assert.equal((await terminal(editedBudget.runId)).result, 3,
    "removing an earlier getter diverges to the current budget instead of shifting old observations");
  assert.equal(calls.length, budgetCallCount, "budget-observation divergence can still reuse the preceding matching call");

  const raced = await run(`
export const meta = { name: 'race', description: 'Replay delivery order' }
return await parallel([() => agent('slow'), () => agent('fast')])`);
  assert.deepEqual((await terminal(raced.runId)).result, ["done:slow", "done:fast"]);
  const racedCallCount = calls.length;
  const diverged = await run(`
export const meta = { name: 'race', description: 'Replay delivery order' }
return await parallel([() => agent('slow'), () => agent('changed')])`, { resumeFromRunId: raced.runId });
  assert.deepEqual((await terminal(diverged.runId)).result, ["done:slow", "done:changed"]);
  assert.equal(calls.length, racedCallCount + 1, "a missing recorded delivery switches to live without hanging cached siblings");

  const promiseRace = await run(`
export const meta = { name: 'promise-race', description: 'Promise race replay' }
return await Promise.race([agent('slow'), agent('fast')])`);
  const promiseRaceWinner = (await terminal(promiseRace.runId)).result;
  assert(["done:slow", "done:fast"].includes(promiseRaceWinner));
  const promiseRaceCallCount = calls.length;
  const promiseRaceReplay = await run(`
export const meta = { name: 'promise-race', description: 'Promise race replay' }
return await Promise.race([agent('slow'), agent('fast')])`, { resumeFromRunId: promiseRace.runId });
  assert.equal((await terminal(promiseRaceReplay.runId)).result, promiseRaceWinner,
    "cached promises are released in their recorded delivery order");
  assert.equal(calls.length, promiseRaceCallCount, "promise race replay does not dispatch providers");

  const definitions = join(root, ".devspace", "workflows");
  await mkdir(definitions, { recursive: true });
  await writeFile(join(definitions, "child.js"), `
export const meta = { name: 'child', description: 'Nested child' }
return await agent('nested')`);
  const nested = await run(`
export const meta = { name: 'parent', description: 'Nested parent' }
return await workflow('child')`);
  const nestedSnapshot = await terminal(nested.runId);
  assert.equal(nestedSnapshot.state, "completed", JSON.stringify(nestedSnapshot));
  assert.equal(nestedSnapshot.result, "done:nested");
  const nestedSteps = workflowStore.listSteps(nested.runId);
  assert.deepEqual(nestedSteps.map((step) => step.kind), ["workflow", "agent"]);
  assert.equal(new Set(nestedSteps.map((step) => step.deliverySequence)).size, 2,
    "nested and root deliveries share one sequence");
  const nestedCallCount = calls.length;
  const nestedReplay = await run(`
export const meta = { name: 'parent', description: 'Nested parent' }
return await workflow('child')`, { resumeFromRunId: nested.runId });
  assert.equal((await terminal(nestedReplay.runId)).result, "done:nested");
  assert.equal(calls.length, nestedCallCount, "nested replay executes the child body but reuses matching internal calls");

  await writeFile(join(definitions, "queued-child.js"), `
export const meta = { name: 'queued-child', description: 'Nested queue child' }
return await agent(args.prompt)`);
  const nestedQueueCallCount = calls.length;
  const nestedQueueDiscoveries = workflowRegistry.discoveries;
  const queuedNested = await run(`
export const meta = { name: 'queued-parent', description: 'Nested queue parent' }
return await parallel([
  () => workflow('queued-child', { prompt: 'hold' }),
  () => workflow('queued-child', { prompt: 'hold' }),
])`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const steps = workflowStore.listSteps(queuedNested.runId);
    if (steps.filter((step) => step.kind === "workflow").length === 2
      && steps.some((step) => step.kind === "agent" && step.state === "running")) break;
    await delay(5);
  }
  assert.equal(calls.length, nestedQueueCallCount + 1, "only the child holding the nested slot dispatches an agent");
  assert.equal(workflowRegistry.discoveries, nestedQueueDiscoveries + 1,
    "parallel nested name lookups share one discovery snapshot per run");
  const queuedStop = await manager.request({ operation: "control", scope,
    input: { runId: queuedNested.runId, action: "stop" } });
  assert.equal(queuedStop.ok, true);
  assert.equal((await terminal(queuedNested.runId)).state, "stopped");
  assert.equal(calls.length, nestedQueueCallCount + 1, "an aborted queued child never starts after the slot is released");

  const isolated = await run(`
export const meta = { name: 'isolated', description: 'Isolated agent' }
return await agent('isolated', { isolation: 'worktree' })`);
  assert.equal((await terminal(isolated.runId)).state, "completed");
  assert.equal(worktrees, 1);
  assert.equal(workflowStore.listSteps(isolated.runId)[0]?.worktree?.baseSha, "abc123");
  assert.equal(workflowStore.listSteps(isolated.runId)[0]?.worktree?.changed, true);
  assert.equal((await terminal(isolated.runId)).worktrees[0].changed, true);

  const large = await run(`
export const meta = { name: 'large', description: 'Artifact-backed result' }
return await agent('large-output')`);
  const largeSnapshot = await terminal(large.runId);
  assert.equal(largeSnapshot.result, undefined);
  assert.match(largeSnapshot.resultPreview, /truncated/);
  assert.equal(JSON.parse(await readFile(largeSnapshot.resultArtifact.path, "utf8")).length, 70_000);
  const largeStep = workflowStore.listSteps(large.runId)[0]!;
  const largeDetail = success(await manager.request({ operation: "get", scope,
    input: { runId: large.runId, stepId: largeStep.id } })) as any;
  assert.equal(largeDetail.output, undefined);
  assert.equal(JSON.parse(await readFile(largeDetail.outputArtifact.path, "utf8")).length, 70_000);

  const restarted = await run(`
export const meta = { name: 'restarted', description: 'Restarted agent' }
return await agent('hold-restart')`);
  for (let attempt = 0; attempt < 100 && workflowStore.listSteps(restarted.runId)[0]?.state !== "running"; attempt++) {
    await delay(5);
  }
  const restartStep = workflowStore.listSteps(restarted.runId)[0]!;
  const restartReply = await manager.request({ operation: "control", scope,
    input: { runId: restarted.runId, action: "restart_agent", stepId: restartStep.id } });
  assert.equal(restartReply.ok, true);
  assert.equal((await terminal(restarted.runId)).result, "done:hold-restart");
  assert.equal(workflowStore.listAttempts(restartStep.id).length, 2);

  const paused = await run(`
export const meta = { name: 'paused', description: 'Paused scheduling' }
const first = await agent('slow')
return [first, await agent('after-pause')]`);
  for (let attempt = 0; attempt < 100 && !calls.some((call) => call.workflowRunId === paused.runId); attempt++) {
    await delay(2);
  }
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: paused.runId, action: "pause" } })).ok, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = success(await manager.request({ operation: "get", scope, input: { runId: paused.runId } })) as any;
    if (snapshot.state === "paused") break;
    await delay(5);
  }
  assert.equal(calls.some((call) => call.workflowRunId === paused.runId && call.prompt === "after-pause"), false);
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: paused.runId, action: "resume" } })).ok, true);
  assert.deepEqual((await terminal(paused.runId)).result, ["done:slow", "done:after-pause"]);

  const defaultActiveMs = workflowsConfig.limits.runActiveMs;
  workflowsConfig.limits.runActiveMs = 50;
  const clockPaused = await run(`
export const meta = { name: 'clock-paused', description: 'Paused active-time clock' }
return await agent('after-clock-pause')`);
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: clockPaused.runId, action: "pause" } })).ok, true);
  await delay(80);
  const parkedSnapshot = success(await manager.request({ operation: "get", scope,
    input: { runId: clockPaused.runId } })) as any;
  assert.equal(parkedSnapshot.state, "paused", "parked pause time does not consume active-time budget");
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: clockPaused.runId, action: "resume" } })).ok, true);
  assert.equal((await terminal(clockPaused.runId)).result, "done:after-clock-pause");
  workflowsConfig.limits.runActiveMs = defaultActiveMs;

  const heldRestart = await run(`
export const meta = { name: 'held-restart', description: 'Restart before delivery' }
return await agent('slow-restart')`);
  for (let attempt = 0; attempt < 100 && !calls.some((call) => call.workflowRunId === heldRestart.runId); attempt++) {
    await delay(2);
  }
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: heldRestart.runId, action: "pause" } })).ok, true);
  let heldStep;
  for (let attempt = 0; attempt < 100; attempt++) {
    heldStep = workflowStore.listSteps(heldRestart.runId)[0];
    if (heldStep?.state === "completed") break;
    await delay(5);
  }
  assert.equal(heldStep?.state, "completed");
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: heldRestart.runId, action: "restart_agent", stepId: heldStep!.id } })).ok, true);
  assert.equal((await manager.request({ operation: "control", scope,
    input: { runId: heldRestart.runId, action: "resume" } })).ok, true);
  assert.equal((await terminal(heldRestart.runId)).result, "done:slow-restart:2");
  assert.equal(workflowStore.listAttempts(heldStep!.id).length, 2);

  const budgeted = await run(`
export const meta = { name: 'budgeted', description: 'Finite budget' }
await agent('budget-one')
return await agent('budget-two')`, { outputTokenBudget: 3 });
  const budgetSnapshot = await terminal(budgeted.runId);
  assert.equal(budgetSnapshot.state, "failed");
  assert.equal(budgetSnapshot.error.code, "BUDGET_EXHAUSTED");
  assert.equal(calls.some((call) => call.workflowRunId === budgeted.runId && call.prompt === "budget-two"), false);

  workflowsConfig.limits.runActiveMs = 100;
  const rateLimited = await run(`
export const meta = { name: 'rate-limited', description: 'Provider usage gate' }
return await agent('rate-once')`);
  let sawUsageGate = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = success(await manager.request({ operation: "get", scope, input: { runId: rateLimited.runId } })) as any;
    if (snapshot.state === "waiting_for_usage" && snapshot.nextEligibleAt) { sawUsageGate = true; break; }
    await delay(2);
  }
  assert.equal(sawUsageGate, true, "recognized provider reset metadata persists a bounded usage gate");
  assert.equal((await terminal(rateLimited.runId)).result, "done:rate-once");
  assert.equal(promptCalls.get("rate-once"), 2);
  workflowsConfig.limits.runActiveMs = defaultActiveMs;

  workflowsConfig.maxAttemptsPerRun = 1;
  const capped = await run(`
export const meta = { name: 'capped', description: 'Atomic attempt cap' }
return await parallel([() => agent('cap-one'), () => agent('cap-two')])`);
  const cappedSnapshot = await terminal(capped.runId);
  workflowsConfig.maxAttemptsPerRun = defaultWorkflowsConfig().maxAttemptsPerRun;
  assert.equal(cappedSnapshot.state, "completed");
  assert.equal(cappedSnapshot.partial, true);
  assert.equal(workflowStore.countAttempts(capped.runId), 1);
  assert.equal(calls.filter((call) => call.workflowRunId === capped.runId).length, 1,
    "the attempt cap is rechecked before provider dispatch");

  const failedRoot = await run(`
export const meta = { name: 'failed-root', description: 'Root admission closes on failure' }
for (let index = 0; index < 20; index++) agent('hold-failure-' + index)
throw new Error('root failed')`);
  assert.equal((await terminal(failedRoot.runId)).state, "failed");
  const failedDispatches = calls.filter((call) => call.workflowRunId === failedRoot.runId).length;
  await delay(50);
  assert.equal(calls.filter((call) => call.workflowRunId === failedRoot.runId).length, failedDispatches,
    "root failure closes queued provider admission");
  assert.equal(agentStore.list().some((agent) => agent.status === "running"), false);

  const stopped = await run(`
export const meta = { name: 'stopped', description: 'Stopped run' }
return await agent('hold-stop')`);
  for (let attempt = 0; attempt < 100 && workflowStore.listSteps(stopped.runId)[0]?.state !== "running"; attempt++) {
    await delay(5);
  }
  const stopReply = await manager.request({ operation: "control", scope,
    input: { runId: stopped.runId, action: "stop" } });
  assert.equal(stopReply.ok, true);
  assert.equal((await terminal(stopped.runId)).state, "stopped");
  assert.equal(agentStore.list().some((agent) => agent.status === "running"), false);

  const crossScope = await manager.request({ operation: "get",
    scope: { workspaceId: "other", workspaceRoot: root }, input: { runId: first.runId } });
  assert.equal(crossScope.ok, false);

  const recovering = workflowStore.createRun({ workspaceId: scope.workspaceId, workspaceRoot: root,
    meta: { name: "recovering", description: "known live turn" }, scriptSource: "", scriptHash: "x",
    argsPresent: false, defaults: {}, policy: {}, runtimeVersion: "devspace-workflow/v1" });
  const recoveringStep = workflowStore.createStep({ runId: recovering.id, kind: "agent", logicalPath: "0:1",
    requestHash: "recovering", request: { prompt: "recovering" }, workspaceId: scope.workspaceId });
  const recoveringAgent = agentStore.create({ workspaceId: scope.workspaceId, workspaceRoot: root,
    profileName: "reviewer", provider: "codex", writeMode: "read_only" });
  const recoveringTurn = agentStore.beginTurn(recoveringAgent.id, { prompt: "recovering", writeMode: "read_only" }).turn;
  const recoveringAttempt = workflowStore.createAttempt({ stepId: recoveringStep.id,
    agentId: recoveringAgent.id, agentTurnId: recoveringTurn.id, reason: "initial" });
  workflowStore.transitionAttempt(recoveringAttempt.id, "running");
  workflowStore.markActiveAttemptsUncertain();
  agentStore.reconcileActiveRuns();
  assert.equal(agentStore.getTurnById(recoveringTurn.id)?.status, "failed");
  assert.equal(agentStore.getTurnById(recoveringTurn.id)?.executionUncertain, true);
  const blockedResume = await manager.request({ operation: "run", scope, input: { resumeFromRunId: recovering.id,
    script: `export const meta = { name: 'recovering', description: 'known live turn' }\nreturn null` } });
  assert.equal(blockedResume.ok, false);
  if (!blockedResume.ok) assert.equal(blockedResume.error.code, "WORKFLOW_BUSY");

  const stale = workflowStore.createRun({ workspaceId: scope.workspaceId, workspaceRoot: root,
    meta: { name: "stale", description: "stale" }, scriptSource: "", scriptHash: "x",
    argsPresent: false, defaults: {}, policy: {}, runtimeVersion: "devspace-workflow/v1" });
  assert.equal(manager.reconcileActiveRuns(), 1);
  assert.equal(workflowStore.getRun(stale.id)?.state, "recovery_required");
} finally {
  await manager.close();
  await agents.close();
  database.close();
  await rm(root, { recursive: true, force: true });
}

async function run(script: string, extra: { resumeFromRunId?: string; outputTokenBudget?: number } = {}) {
  const reply = await manager.request({ operation: "run", scope, input: { script, ...extra } });
  return success(reply) as { runId: string };
}

async function terminal(runId: string): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const reply = await manager.request({ operation: "get", scope, input: { runId } });
    const snapshot = success(reply) as any;
    if (["completed", "failed", "stopped", "recovery_required"].includes(snapshot.state)) return snapshot;
    await delay(10);
  }
  throw new Error(`Workflow ${runId} did not finish.`);
}

function success(reply: WorkflowReply): unknown {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result;
}
