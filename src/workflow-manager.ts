import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePathInsideCanonicalRoot } from "./roots.js";
import type { WorkflowsConfig } from "./workflow-config.js";
import type { LocalAgentInvocationResolution, LocalAgentManager } from "./local-agent-manager.js";
import type { LocalAgentStore, LocalAgentTurnRecord } from "./local-agent-store.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { parseStructuredOutput, validateJsonSchema, validateStructuredOutput } from "./workflow-schema.js";
import { executeWorkflowScript, preflightWorkflowScript } from "./workflow-runtime.js";
import type {
  AgentOptions,
  JsonObject,
  JsonValue,
  ParsedWorkflowScript,
  WorkflowAgentRequest,
  WorkflowBridgeContext,
  WorkflowBridgeReply,
  WorkflowBudgetSnapshot,
  WorkflowNestedRequest,
  WorkflowRuntimeEvent,
  WorkflowRuntimeLimits,
} from "./workflow-types.js";
import type { WorkflowReply, WorkflowRequest, WorkflowScope } from "./workflow-protocol.js";
import { WorkflowRegistry, type WorkflowDiscoveryResult } from "./workflow-registry.js";
import {
  WorkflowStore,
  type WorkflowError,
  type WorkflowRunRecord,
  type WorkflowState,
  type WorkflowStepRecord,
} from "./workflow-store.js";

const RUNTIME_VERSION = "devspace-workflow/v1";
const ATTENTION_STATES = new Set<WorkflowState>(["paused", "waiting_for_permission", "waiting_for_usage", "recovery_required"]);
const TERMINAL_STATES = new Set<WorkflowState>(["completed", "failed", "stopped", "recovery_required"]);

export interface WorkflowWorktree {
  workspaceId: string;
  workspaceRoot: string;
  baseSha: string;
  changed?: boolean;
}

export interface WorkflowManagerOptions {
  stateDir: string;
  agents: LocalAgentManager;
  agentStore: LocalAgentStore;
  config: WorkflowsConfig;
  store?: WorkflowStore;
  registry?: WorkflowRegistry;
  validateScope: (scope: WorkflowScope) => Promise<WorkflowScope>;
  createWorktree?: (input: { runId: string; stepId: string; scope: WorkflowScope }) => Promise<WorkflowWorktree>;
  inspectWorktree?: (input: {
    runId: string; stepId: string; scope: WorkflowScope; worktree: WorkflowWorktree;
  }) => Promise<{ changed: boolean }>;
}

export interface RunWorkflowReceipt {
  runId: string;
  status: "running";
  workflowName: string;
  scriptPath: string;
  transcriptDir: string;
  revision: number;
  resumedFromRunId?: string;
  warnings?: Array<{ code: string; message: string }>;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
  pauseRequested: boolean;
  pauseWaiters: Set<() => void>;
  activeAttempts: number;
  stepsByRequest: Map<string, string>;
  liveSteps: Map<string, LiveStep>;
  replay?: {
    prefix: WorkflowStepRecord[];
    index: number;
    live: boolean;
    deliveryOrder: WorkflowStepRecord[];
    deliveryIndex: number;
    waiting: Map<string, () => void>;
    priorByNewStep: Map<string, string>;
  };
  cancellation?: Promise<boolean>;
  deliverySequence: number;
  eventCount: number;
  logBytes: number;
  usageNotBefore: number;
  stopRequested: boolean;
  activeClock: ActiveTimeClock;
  waitingUsageAttempts: number;
  workflowDiscovery?: Promise<WorkflowDiscoveryResult>;
}

interface LiveStep {
  step: WorkflowStepRecord;
  request: WorkflowAgentRequest;
  scope: WorkflowScope;
  turn?: LocalAgentTurnRecord;
  stopRequested: boolean;
  restartRequested: boolean;
  delivered: boolean;
}

interface RuntimeContext {
  run: WorkflowRunRecord;
  active: ActiveRun;
  script: ParsedWorkflowScript;
  scope: WorkflowScope;
  depth: 0 | 1;
  parentStepId?: string;
  replayParentStepId?: string;
}

type ReplayState = NonNullable<ActiveRun["replay"]>;

export class WorkflowManager {
  private readonly agents: LocalAgentManager;
  private readonly agentStore: LocalAgentStore;
  private readonly config: WorkflowsConfig;
  private readonly store: WorkflowStore;
  private readonly registry: WorkflowRegistry;
  private readonly createWorktree?: WorkflowManagerOptions["createWorktree"];
  private readonly inspectWorktree?: WorkflowManagerOptions["inspectWorktree"];
  private readonly validateScope: WorkflowManagerOptions["validateScope"];
  private readonly scheduler: FairScheduler;
  private readonly nestedScheduler: AbortableSemaphore;
  private readonly active = new Map<string, ActiveRun>();
  private readonly revisionWaiters = new Map<string, Set<() => void>>();
  private closing = false;
  private pendingLaunches = 0;

  constructor(options: WorkflowManagerOptions) {
    this.agents = options.agents;
    this.agentStore = options.agentStore;
    this.config = options.config;
    this.store = options.store ?? new WorkflowStore(options.stateDir);
    this.registry = options.registry ?? new WorkflowRegistry({ scriptBytes: options.config.limits.scriptBytes });
    this.createWorktree = options.createWorktree;
    this.inspectWorktree = options.inspectWorktree;
    this.validateScope = options.validateScope;
    this.scheduler = new FairScheduler(options.config.maxConcurrentAgents);
    this.nestedScheduler = new AbortableSemaphore(options.config.maxConcurrentRuns);
  }

  get activeRunCount(): number { return this.active.size; }

  reconcileActiveRuns(): number {
    return this.store.markActiveAttemptsUncertain();
  }

  async request(request: WorkflowRequest): Promise<WorkflowReply> {
    try {
      const result = await this.dispatch(request);
      return { ok: true, result };
    } catch (error) {
      const workflowError = toWorkflowError(error);
      return { ok: false, error: workflowError };
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const run of this.active.values()) {
      run.stopRequested = true;
      run.controller.abort(new Error("Workflow daemon is closing."));
      this.scheduler.cancelRun(run.runId);
    }
    await Promise.allSettled([...this.active.values()].map((run) => run.promise));
    this.store.close();
  }

  private async dispatch(request: WorkflowRequest): Promise<unknown> {
    const scope = await this.validateScope(request.scope);
    switch (request.operation) {
      case "run": return this.launch(scope, request.input);
      case "get": return this.get(scope, request.input.runId, request.input.afterRevision, request.input.stepId);
      case "wait": return this.wait(scope, request.input.runId, request.input.afterRevision, request.input.timeoutMs);
      case "control": return this.control(scope, request.input);
      case "list": return this.list(scope, request.input);
      case "save": return this.save(scope, request.input);
    }
  }

  async launch(
    scope: WorkflowScope,
    input: Extract<WorkflowRequest, { operation: "run" }>["input"],
  ): Promise<RunWorkflowReceipt> {
    if (!this.config.enabled || this.closing) throw workflowFailure("WORKFLOW_DISABLED", "Dynamic workflows are disabled.");
    const executingRuns = [...this.active.keys()].filter((runId) => {
      const state = this.store.getRun(runId)?.state;
      return state !== undefined && !TERMINAL_STATES.has(state);
    }).length;
    if (executingRuns + this.pendingLaunches >= this.config.maxConcurrentRuns) {
      throw workflowFailure("WORKFLOW_BUSY", "The workflow run limit is active.", true);
    }
    this.pendingLaunches += 1;
    try {
    const source = await this.resolveSource(scope, input);
    await preflightWorkflowScript(source.parsed, { limits: runtimeLimits(this.config) });
    const budget = input.outputTokenBudget ?? this.config.defaultOutputTokenBudget;
    if (budget && this.config.maxOutputTokenBudget && budget > this.config.maxOutputTokenBudget) {
      throw workflowFailure("BUDGET_EXHAUSTED", "The requested output-token budget exceeds the configured maximum.");
    }
    const sourceRun = input.resumeFromRunId ? this.requireRun(scope, input.resumeFromRunId) : undefined;
    if (sourceRun?.state === "recovery_required") {
      const hasUnconfirmedTurn = this.store.listAttemptsForRun(sourceRun.id)
        .some((attempt) => {
          const turn = this.agentStore.getTurnById(attempt.agentTurnId);
          return turn?.status === "running" || turn?.executionUncertain === true;
        });
      if (hasUnconfirmedTurn) throw workflowFailure("WORKFLOW_BUSY",
        "The source workflow has a provider turn whose termination is unconfirmed; reconcile it before resuming.", true);
    }
    const defaults = compactJson({
      ...(sourceRun?.defaults ?? {}),
      agentType: input.agentType ?? stringValue(sourceRun?.defaults.agentType),
      model: input.model ?? stringValue(sourceRun?.defaults.model),
      effort: input.effort ?? stringValue(sourceRun?.defaults.effort),
    });
    const argsPresent = Object.hasOwn(input, "args") ? true : sourceRun?.argsPresent ?? false;
    const args = Object.hasOwn(input, "args") ? input.args : sourceRun?.args;
    const policy = sourceRun?.policy ?? policySnapshot(this.config);
    const runId = id("wf");
    const create = {
      id: runId,
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      meta: source.parsed.meta as unknown as JsonObject,
      scriptSource: source.parsed.source,
      scriptHash: hash(source.parsed.source),
      sourcePath: source.path,
      argsPresent,
      args,
      defaults,
      policy,
      runtimeVersion: RUNTIME_VERSION,
      outputTokenBudget: budget,
    };
    const canonicalRoot = await realpath(scope.workspaceRoot);
    const transcriptDir = await resolvePathInsideCanonicalRoot(
      join(".devspace", "workflows", "runs", runId), scope.workspaceRoot, scope.workspaceRoot, canonicalRoot,
    );
    await mkdir(transcriptDir, { recursive: true, mode: 0o700 });
    const editableScriptPath = await resolvePathInsideCanonicalRoot(
      join(transcriptDir, "workflow.js"), canonicalRoot, canonicalRoot, canonicalRoot,
    );
    await writeFile(editableScriptPath, source.parsed.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const run = input.resumeFromRunId
      ? this.store.createResumedRun({ ...create, sourceRunId: input.resumeFromRunId })
      : this.store.createRun(create);
    await this.writeExport(run, "journal.jsonl", "");
    const active = this.start(run, source.parsed, scope);
    this.active.set(run.id, active);
    return {
      runId: run.id,
      status: "running",
      workflowName: source.parsed.meta.name,
      scriptPath: editableScriptPath,
      transcriptDir,
      revision: run.revision,
      resumedFromRunId: input.resumeFromRunId,
    };
    } finally {
      this.pendingLaunches -= 1;
    }
  }

  async get(scope: WorkflowScope, runId: string, afterRevision = 0, stepId?: string): Promise<unknown> {
    const run = this.requireRun(scope, runId);
    if (stepId) {
      const step = this.store.getStep(stepId);
      if (!step || step.runId !== runId) throw workflowFailure("WORKFLOW_NOT_FOUND", `Unknown workflow step: ${stepId}`);
      const attempts = this.store.listAttempts(step.id);
      if (step.output !== undefined && jsonByteLength(step.output) > 64 * 1024) {
        const outputArtifact = await this.exportStepOutput(run, step);
        const { output: _output, ...summary } = step;
        return { ...summary, outputPreview: jsonPreview(step.output), outputArtifact, attempts };
      }
      return { ...step, attempts };
    }
    return this.snapshot(run, afterRevision);
  }

  async wait(scope: WorkflowScope, runId: string, afterRevision?: number, timeoutMs = 30_000): Promise<unknown> {
    let run = this.requireRun(scope, runId);
    const baseline = afterRevision ?? run.revision;
    if (!TERMINAL_STATES.has(run.state) && !ATTENTION_STATES.has(run.state) && run.revision <= baseline && timeoutMs > 0) {
      await new Promise<void>((resolveWait) => {
        const waiters = this.revisionWaiters.get(runId) ?? new Set();
        const done = () => { clearTimeout(timer); waiters.delete(done); resolveWait(); };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
        this.revisionWaiters.set(runId, waiters);
      });
      run = this.requireRun(scope, runId);
    }
    return this.snapshot(run, baseline);
  }

  async control(
    scope: WorkflowScope,
    input: Extract<WorkflowRequest, { operation: "control" }>["input"],
  ): Promise<unknown> {
    const run = this.requireRun(scope, input.runId);
    const active = this.active.get(run.id);
    if (!active) {
      if (input.action === "stop" && TERMINAL_STATES.has(run.state)) return this.snapshot(run);
      throw workflowFailure("WORKFLOW_BUSY", `Workflow ${run.id} is not live.`);
    }
    if (input.action === "pause") {
      if (!active.pauseRequested) {
        active.pauseRequested = true;
        this.refreshActiveClock(active);
        this.changeRun(run.id, active.activeAttempts ? "pausing" : "paused", "Paused by user.");
      }
    } else if (input.action === "resume") {
      active.pauseRequested = false;
      this.refreshActiveClock(active);
      this.changeRun(run.id, "running");
      for (const resume of active.pauseWaiters) resume();
      active.pauseWaiters.clear();
      this.scheduler.wake();
    } else if (input.action === "stop") {
      this.changeRun(run.id, "stopping", "Stopped by user.");
      active.stopRequested = true;
      active.controller.abort(new Error("Workflow stopped."));
      this.scheduler.cancelRun(run.id);
      active.cancellation ??= this.cancelOwned(active);
      const confirmed = await active.cancellation;
      if (!confirmed) this.changeRun(run.id, "recovery_required", "Cancellation could not be confirmed.",
        undefined, false, workflowFailure("CANCELLATION_UNCONFIRMED", "One or more agent turns may still be active."));
    } else {
      const live = input.stepId ? active.liveSteps.get(input.stepId) : undefined;
      if (!live || live.step.kind !== "agent") {
        const stored = input.stepId ? this.store.getStep(input.stepId) : undefined;
        if (input.action === "restart_agent" && stored?.runId === run.id && stored.deliverySequence) {
          throw workflowFailure("STEP_ALREADY_DELIVERED", "The step result was already delivered to the script.");
        }
        throw workflowFailure("WORKFLOW_NOT_FOUND", `Unknown live agent step: ${input.stepId}`);
      }
      if (input.action === "restart_agent" && live.delivered) {
        throw workflowFailure("STEP_ALREADY_DELIVERED", "The step result was already delivered to the script.");
      }
      live.restartRequested = input.action === "restart_agent";
      live.stopRequested = input.action === "stop_agent";
      if (live.turn) {
        const stopped = await this.agents.stop(live.turn.agentId, live.turn.id, live.scope);
        if (stopped.isErr()) throw stopped.error;
      }
    }
    return this.snapshot(this.requireRun(scope, run.id));
  }

  async list(scope: WorkflowScope, input: Extract<WorkflowRequest, { operation: "list" }>["input"]): Promise<unknown> {
    const limit = input.limit ?? 20;
    if (input.kind === "definitions") {
      const discovered = await this.registry.discover(scope.workspaceRoot);
      const definitions = discovered.definitions.sort((left, right) => left.name.localeCompare(right.name));
      const offset = input.cursor ? Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw workflowFailure("WORKFLOW_SOURCE_INVALID", "Invalid workflow cursor.");
      const page = definitions.slice(offset, offset + limit);
      return { definitions: page.map(({ source, parsed, ...item }) => item),
        invalid: discovered.invalid, conflicts: discovered.conflicts,
        nextCursor: offset + limit < definitions.length ? Buffer.from(String(offset + limit)).toString("base64url") : undefined };
    }
    const before = decodeCursor(input.cursor);
    const runs = this.store.listRuns(scope.workspaceId, limit + 1, before);
    const page = runs.slice(0, limit);
    return { runs: await Promise.all(page.map((run) => this.snapshot(run))),
      nextCursor: runs.length > limit ? encodeCursor(page.at(-1)!) : undefined };
  }

  async save(scope: WorkflowScope, input: Extract<WorkflowRequest, { operation: "save" }>["input"]): Promise<unknown> {
    const run = this.requireRun(scope, input.runId);
    const saved = await this.registry.save({ workspaceRoot: scope.workspaceRoot, source: run.scriptSource,
      name: input.name, location: input.location, replace: input.replace });
    return { name: saved.name, sourcePath: saved.sourcePath, origin: saved.origin, meta: saved.meta };
  }

  private start(run: WorkflowRunRecord, script: ParsedWorkflowScript, scope: WorkflowScope): ActiveRun {
    const controller = new AbortController();
    const activeClock = new ActiveTimeClock(
      this.config.limits.runActiveMs,
      this.config.limits.runActiveMs
        + this.config.maxUsageLimitWaitMs * this.config.maxUsageLimitWaits
        + 7 * 24 * 60 * 60 * 1_000,
    );
    const active: ActiveRun = {
      runId: run.id, controller, promise: Promise.resolve(), pauseRequested: false,
      pauseWaiters: new Set(), activeAttempts: 0, stepsByRequest: new Map(), liveSteps: new Map(),
      deliverySequence: 0,
      eventCount: 0,
      logBytes: 0,
      usageNotBefore: 0,
      stopRequested: false,
      activeClock,
      waitingUsageAttempts: 0,
      replay: run.resumedFromRunId ? replayState(this.store.findReplayPrefix(run.resumedFromRunId)) : undefined,
    };
    active.promise = this.execute({ run, active, script, scope, depth: 0 })
      .then(async (result) => {
        if (controller.signal.aborted) {
          active.cancellation ??= this.cancelOwned(active);
          if (await active.cancellation) this.changeRun(run.id, "stopped", "Stopped by user.");
        } else {
          if (result.partial) this.store.appendEvent(run.id, "warning", {
            code: "PARTIAL_EXECUTION", message: "One or more workflow tasks failed or were stopped.",
          });
          this.changeRun(run.id, "completed", undefined, result.result, result.omittedResult);
        }
        await this.exportRunArtifacts(this.store.getRun(run.id)!).catch((error) => {
          this.store.appendEvent(run.id, "warning", { code: "ARTIFACT_EXPORT_FAILED", message: errorMessage(error) });
        });
      })
      .catch(async (error) => {
        const failure = toWorkflowError(error, run.id);
        const stoppedByControl = active.stopRequested;
        if (!controller.signal.aborted) controller.abort(error);
        this.scheduler.cancelRun(run.id);
        active.cancellation ??= this.cancelOwned(active);
        const confirmed = await active.cancellation;
        if (!confirmed) this.changeRun(run.id, "recovery_required", "Cancellation could not be confirmed.", undefined, false,
          workflowFailure("CANCELLATION_UNCONFIRMED", "One or more agent turns may still be active."));
        else this.changeRun(run.id, stoppedByControl ? "stopped" : "failed", failure.message, undefined, false, failure);
        await this.exportRunArtifacts(this.store.getRun(run.id)!).catch((exportError) => {
          this.store.appendEvent(run.id, "warning", { code: "ARTIFACT_EXPORT_FAILED", message: errorMessage(exportError) });
        });
      })
      .finally(() => { activeClock.dispose(); this.active.delete(run.id); this.notify(run.id); });
    this.changeRun(run.id, "running");
    return active;
  }

  private execute(context: RuntimeContext) {
    const budget = this.budget(context.run);
    return executeWorkflowScript({
      script: context.script,
      argsPresent: context.run.argsPresent,
      args: context.run.args,
      generation: context.run.executionGeneration,
      depth: context.depth,
      budget,
      limits: runtimeLimits(this.config),
      signal: context.active.controller.signal,
      replay: context.run.resumedFromRunId ? {
        events: this.store.listEvents(context.run.resumedFromRunId, 0, 100_000)
          .filter((event) => (event.type === "phase" || event.type === "log")
            && event.stepId === context.replayParentStepId)
          .map((event) => event.type === "phase"
            ? { type: "phase" as const, title: String(event.payload.title) }
            : { type: "log" as const, message: String(event.payload.message) }),
        budgetObservations: this.store.listEvents(context.run.resumedFromRunId, 0, 100_000)
          .filter((event) => event.type === "budget_observation"
            && event.stepId === context.replayParentStepId)
          .map((event) => ({
            getter: event.payload.getter as "spent" | "remaining",
            value: event.payload.value as number | "Infinity",
            location: event.payload.location as { line: number; column: number } | undefined,
          })),
      } : undefined,
      callbacks: {
        agent: (request, bridge) => this.agent(context, request, bridge),
        workflow: (request, bridge) => this.nested(context, request, bridge),
        event: (event) => this.runtimeEvent(context, event),
        control: () => this.pauseGate(context.active),
        budget: () => this.budget(context.run),
        nextDeliverySequence: () => ++context.active.deliverySequence,
        waitForActiveTimeout: (_timeoutMs, signal) => context.active.activeClock.wait(signal),
      },
    });
  }

  private async agent(
    context: RuntimeContext,
    request: WorkflowAgentRequest,
    bridge: WorkflowBridgeContext,
  ): Promise<WorkflowBridgeReply> {
    const run = this.store.getRun(context.run.id)!;
    const defaults = run.defaults as { agentType?: JsonValue; model?: JsonValue; effort?: JsonValue };
    const target = request.options.agentType ?? stringValue(defaults.agentType) ?? this.config.defaultAgentType;
    if (!target) throw workflowFailure("AGENT_TARGET_UNAVAILABLE", "No workflow agent target is configured.");
    const requested = { ...request.options, agentType: target,
      model: request.options.model ?? phaseModel(context.script, request.phase) ?? stringValue(defaults.model),
      effort: request.options.effort ?? stringValue(defaults.effort) };
    const resolved = await this.agents.resolveInvocation({ target, workspaceRoot: context.scope.workspaceRoot,
      workspaceId: context.scope.workspaceId, model: requested.model, effort: requested.effort,
      outputSchema: typeof requested.schema === "object" ? requested.schema : undefined });
    if (resolved.isErr()) throw resolved.error;
    if (context.active.controller.signal.aborted) throw context.active.controller.signal.reason;
    const effective = { ...requested, agentType: resolved.value.target, model: resolved.value.model,
      effort: resolved.value.effort };
    const requestObject = { prompt: request.prompt, options: effective,
      phase: request.options.phase ?? request.phase ?? null,
      invocation: { provider: resolved.value.provider, profileHash: resolved.value.profileHash,
        writeMode: resolved.value.writeMode } } as unknown as JsonObject;
    const requestHash = hash(canonicalJson({ ...requestObject, workspaceId: context.scope.workspaceId, runtimeVersion: RUNTIME_VERSION }));
    const replay = context.active.replay;
    if (replay && !replay.live) {
      const prior = replay.prefix[replay.index];
      if (prior?.requestHash === requestHash && prior.output !== undefined && prior.deliverySequence !== undefined) {
        replay.index += 1;
        const cached = this.store.createStep({ runId: run.id, parentStepId: context.parentStepId, kind: "agent",
          logicalPath: `${context.depth}:${bridge.requestId}`, requestHash, request: requestObject,
          phase: request.options.phase ?? request.phase, label: request.options.label, workspaceId: context.scope.workspaceId,
          cachedFromStepId: prior.id, output: prior.output });
        context.active.stepsByRequest.set(requestKey(context, bridge.requestId), cached.id);
        replay.priorByNewStep.set(cached.id, prior.id);
        this.notify(run.id);
        await waitForReplayDelivery(replay, prior.id);
        return { value: prior.output, budget: this.budget(run), replayed: !replay.live };
      }
      divergeReplay(replay);
    }
    if (this.store.countSteps(run.id).requested >= this.config.maxAgentsPerRun) {
      throw workflowFailure("AGENT_LIMIT", "The workflow agent limit was reached.");
    }
    const step = this.store.createStep({ runId: run.id, parentStepId: context.parentStepId, kind: "agent",
      logicalPath: `${context.depth}:${bridge.requestId}`, requestHash, request: requestObject,
      phase: request.options.phase ?? request.phase, label: request.options.label, workspaceId: context.scope.workspaceId });
    context.active.stepsByRequest.set(requestKey(context, bridge.requestId), step.id);
    const live: LiveStep = { step, request, scope: context.scope, stopRequested: false, restartRequested: false, delivered: false };
    context.active.liveSteps.set(step.id, live);
    try {
      await this.pauseGate(context.active);
      await this.usageGate(context);
      let value = await this.scheduler.schedule(run.id, () => this.runAgent(context, live, effective, resolved.value));
      for (;;) {
        await this.pauseGate(context.active);
        if (live.stopRequested) {
          this.store.transitionStep(live.step.id, "stopped");
          value = null;
          break;
        }
        if (!live.restartRequested) break;
        this.store.transitionStep(live.step.id, "queued");
        value = await this.scheduler.schedule(run.id, () => this.runAgent(context, live, effective, resolved.value));
      }
      return { value, budget: this.budget(run) };
    } finally {
      this.notify(run.id);
    }
  }

  private async runAgent(
    context: RuntimeContext,
    live: LiveStep,
    options: AgentOptions,
    resolution: LocalAgentInvocationResolution,
  ): Promise<JsonValue> {
    if (live.stopRequested || context.active.controller.signal.aborted) {
      this.store.transitionStep(live.step.id, "stopped");
      return null;
    }
    await this.pauseGate(context.active);
    let scope = context.scope;
    let createdWorktree: WorkflowWorktree | undefined;
    if (options.isolation === "worktree") {
      if (!this.createWorktree) throw workflowFailure("WORKSPACE_NOT_ALLOWED", "Worktree isolation is unavailable.");
      const worktree = await this.createWorktree({ runId: context.run.id, stepId: live.step.id, scope });
      createdWorktree = worktree;
      scope = { workspaceId: worktree.workspaceId, workspaceRoot: worktree.workspaceRoot };
      live.scope = scope;
      this.store.transitionStep(live.step.id, "starting", { worktree: {
        workspaceId: worktree.workspaceId, path: worktree.workspaceRoot, baseSha: worktree.baseSha,
        changed: worktree.changed ?? false,
      } });
    }
    const budget = this.store.getBudget(context.run.budgetId);
    if (budget.totalOutputTokens !== null && (!budget.usageComplete || budget.knownOutputTokens >= budget.totalOutputTokens)) {
      throw workflowFailure(budget.usageComplete ? "BUDGET_EXHAUSTED" : "USAGE_UNAVAILABLE", "No further metered attempts may be dispatched.");
    }
    if (options.schema !== undefined) {
      await validateJsonSchema(options.schema, {
        maxBytes: this.config.limits.schemaBytes,
        maxDepth: this.config.limits.schemaDepth,
      });
    }
    if (context.active.controller.signal.aborted) throw context.active.controller.signal.reason;
    const capabilities = resolution.capabilities;
    if (budget.totalOutputTokens !== null && capabilities.usage === "unavailable") {
      throw workflowFailure("USAGE_UNAVAILABLE", "This agent target cannot provide reliable output-token usage.");
    }
    context.active.activeAttempts += 1;
    this.refreshActiveClock(context.active);
    try {
      let agentId = live.restartRequested && live.turn ? live.turn.agentId : undefined;
      let schemaAttempts = 0;
      let restarting = agentId !== undefined;
      if (restarting) live.restartRequested = false;
      let retrying = false;
      let usageWaits = 0;
      for (let attemptIndex = 1; attemptIndex <= this.config.maxAttemptsPerRun; attemptIndex++) {
        await this.usageGate(context);
        if (context.active.controller.signal.aborted) throw context.active.controller.signal.reason;
        const currentBudget = this.store.getBudget(context.run.budgetId);
        if (this.store.countAttempts(context.run.id) >= this.config.maxAttemptsPerRun) {
          throw workflowFailure("ATTEMPT_LIMIT", "The workflow attempt limit was reached.");
        }
        if (currentBudget.totalOutputTokens !== null
          && (!currentBudget.usageComplete || currentBudget.knownOutputTokens >= currentBudget.totalOutputTokens)) {
          throw workflowFailure(currentBudget.usageComplete ? "BUDGET_EXHAUSTED" : "USAGE_UNAVAILABLE",
            "No further metered attempts may be dispatched.");
        }
        const workflowAttemptId = id("wfa");
        const attemptReason = restarting ? "restart" as const
          : retrying ? "retry" as const
          : attemptIndex === 1 ? "initial" as const : "schema_repair" as const;
        let usageSequence = 0;
        let finalUsage = false;
        const usage = async (update: { sequence: number; outputTokens: number; final: boolean }) => {
          usageSequence = Math.max(usageSequence, update.sequence);
          finalUsage ||= update.final;
          this.store.recordUsage({ attemptId: workflowAttemptId, sequence: update.sequence,
            outputTokens: update.outputTokens, complete: update.final });
          this.recordExternalEvent(context, "usage", { attemptId: workflowAttemptId,
            outputTokens: update.outputTokens, complete: update.final }, live.step.id);
          this.notify(context.run.id);
        };
        const callbacks = {
          onUsage: usage,
          onPrepared: (begun: { agent: { id: string }; turn: { id: number } }) => {
            if (context.active.controller.signal.aborted) throw context.active.controller.signal.reason;
            if (live.stopRequested) throw workflowFailure("WORKFLOW_STOPPED", "Workflow agent stopped.");
            if (this.store.countAttempts(context.run.id) >= this.config.maxAttemptsPerRun) {
              throw workflowFailure("ATTEMPT_LIMIT", "The workflow attempt limit was reached.");
            }
            const admissionBudget = this.store.getBudget(context.run.budgetId);
            if (admissionBudget.totalOutputTokens !== null
              && (!admissionBudget.usageComplete
                || admissionBudget.knownOutputTokens >= admissionBudget.totalOutputTokens)) {
              throw workflowFailure(admissionBudget.usageComplete ? "BUDGET_EXHAUSTED" : "USAGE_UNAVAILABLE",
                "No further metered attempts may be dispatched.");
            }
            const preparedAgent = this.agentStore.getById(begun.agent.id);
            if (this.config.requireWorktreesForConcurrentWrites && options.isolation !== "worktree") {
              if (!preparedAgent) throw workflowFailure("WORKSPACE_NOT_ALLOWED", "Agent authority could not be verified.");
              const existingWriter = preparedAgent.writeMode !== "read_only"
                && this.agentStore.list({ workspaceId: scope.workspaceId, workspaceRoot: scope.workspaceRoot })
                  .some((agent) => agent.id !== begun.agent.id
                    && ["starting", "running"].includes(agent.status)
                    && agent.writeMode !== "read_only");
              if (existingWriter) throw workflowFailure("WORKSPACE_NOT_ALLOWED",
                "Concurrent writable workflow agents require worktree isolation.");
            }
            this.store.createAttempt({ id: workflowAttemptId, stepId: live.step.id,
              agentId: begun.agent.id, agentTurnId: begun.turn.id,
              reason: attemptReason });
            this.store.transitionAttempt(workflowAttemptId, "running");
          },
          onProgress: async (progress: { type: "text" | "tool"; text?: string; toolName?: string; status?: string; summary?: string }) => {
            this.recordExternalEvent(context, progress.type === "tool" ? "tool" : "progress", {
              ...(progress.text ? { text: boundedText(progress.text, this.config.limits.logMessageBytes) } : {}),
              ...(progress.toolName ? { name: progress.toolName } : {}),
              ...(progress.status ? { state: progress.status } : {}),
              ...(progress.summary ? { summary: boundedText(progress.summary, this.config.limits.logMessageBytes) } : {}),
            }, live.step.id);
            this.notify(context.run.id);
          },
          onPermissionRequest: async (permission: { requestId: string; description: string; options: readonly { id: string; label: string; kind: string }[] }) => {
            this.store.transitionStep(live.step.id, "waiting_for_permission");
            this.changeRun(context.run.id, "waiting_for_permission", permission.description);
            this.recordExternalEvent(context, "permission", {
              requestId: permission.requestId,
              description: boundedText(permission.description, this.config.limits.logMessageBytes),
              options: permission.options as unknown as JsonValue,
            }, live.step.id);
            this.notify(context.run.id);
            return { outcome: "cancelled" as const };
          },
        };
        const start = agentId
          ? await this.agents.continueTurn(agentId,
              attemptReason === "retry" || attemptReason === "restart"
                ? live.request.prompt : schemaRepairPrompt(options.schema), {
              attemptId: workflowAttemptId, outputSchema: options.schema && typeof options.schema === "object" ? options.schema : undefined,
              expectedProfileHash: resolution.profileHash,
              toolPolicy: attemptReason === "retry" || attemptReason === "restart" ? "normal"
                : capabilities.correctionAuthority === "no_tools" ? "none" : "read_only",
              workflowRunId: context.run.id, workflowStepId: live.step.id, workflowAttemptId,
            }, scope, callbacks)
          : await this.agents.startTurn({ target: options.agentType!, prompt: live.request.prompt,
              workspaceRoot: scope.workspaceRoot, workspaceId: scope.workspaceId, model: options.model,
              effort: options.effort, attemptId: workflowAttemptId,
              writeMode: resolution.writeMode,
              expectedProfileHash: resolution.profileHash,
              outputSchema: options.schema && typeof options.schema === "object" ? options.schema : undefined,
              workflowRunId: context.run.id, workflowStepId: live.step.id, workflowAttemptId,
            }, callbacks);
        if (start.isErr()) {
          if (live.stopRequested || context.active.controller.signal.aborted) {
            this.store.transitionStep(live.step.id, "stopped");
            if (live.stopRequested && !context.active.controller.signal.aborted) return null;
          } else this.store.transitionStep(live.step.id, "failed", { error: toWorkflowError(start.error, context.run.id, live.step.id) });
          throw start.error;
        }
        restarting = false;
        retrying = false;
        agentId = start.value.agent.id;
        live.turn = start.value.turn;
        this.store.transitionStep(live.step.id, "running", { agentId });
        if (live.stopRequested || context.active.controller.signal.aborted) {
          const stopped = await this.agents.stop(live.turn.agentId, live.turn.id, scope);
          if (stopped.isErr()) throw stopped.error;
          this.store.finishAttemptAndStep(workflowAttemptId, "stopped", "stopped");
          if (context.active.controller.signal.aborted) throw context.active.controller.signal.reason;
          return null;
        }
        const waited = await this.agents.wait([agentId], scope, undefined, context.active.controller.signal);
        if (waited.isErr()) throw waited.error;
        const turn = this.agentStore.getTurnById(live.turn.id);
        if (!turn) throw workflowFailure("RECOVERY_REQUIRED", "The agent turn record is missing.");
        if (turn.status === "stopped") {
          if (!finalUsage && capabilities.usage !== "unavailable") this.store.recordUsage({
            attemptId: workflowAttemptId, sequence: usageSequence + 1, outputTokens: undefined, complete: false,
          });
          this.store.transitionAttempt(workflowAttemptId, "stopped");
          if (live.restartRequested) { live.restartRequested = false; restarting = true; continue; }
          this.store.finishAttemptAndStep(workflowAttemptId, "stopped", "stopped");
          return null;
        }
        if (turn.status !== "completed") {
          if (turn.retryAfterMs !== undefined && turn.executionUncertain !== true
            && usageSequence === 0
            && usageWaits < this.config.maxUsageLimitWaits
            && turn.retryAfterMs <= this.config.maxUsageLimitWaitMs) {
            this.store.recordUsage({ attemptId: workflowAttemptId, sequence: 1, outputTokens: 0, complete: true });
            usageWaits += 1;
            this.store.transitionAttempt(workflowAttemptId, "waiting_for_usage");
            this.store.transitionStep(live.step.id, "waiting_for_usage");
            const nextEligibleAt = Date.now() + turn.retryAfterMs;
            if (nextEligibleAt > context.active.usageNotBefore) {
              context.active.usageNotBefore = nextEligibleAt;
              this.store.setNextEligibleAt(context.run.id, new Date(nextEligibleAt).toISOString());
            }
            this.changeRun(context.run.id, "waiting_for_usage", "Waiting for the provider usage limit to reset.");
            await this.usageGate(context);
            this.store.transitionAttempt(workflowAttemptId, "failed", workflowFailure(
              turn.errorCode ?? "PROVIDER_EXECUTION_ERROR", turn.error ?? "Provider usage limit reached.", true,
            ));
            this.store.transitionStep(live.step.id, "queued");
            retrying = true;
            continue;
          }
          if (!finalUsage && capabilities.usage !== "unavailable") this.store.recordUsage({
            attemptId: workflowAttemptId, sequence: usageSequence + 1, outputTokens: undefined, complete: false,
          });
          const error = workflowFailure(turn.errorCode ?? "PROVIDER_EXECUTION_ERROR", turn.error ?? "Agent execution failed.", turn.errorRetryable ?? false);
          this.store.finishAttemptAndStep(workflowAttemptId, "failed", "failed", { error });
          return null;
        }
        if (!finalUsage && capabilities.usage !== "unavailable") this.store.recordUsage({
          attemptId: workflowAttemptId, sequence: usageSequence + 1, outputTokens: undefined, complete: false,
        });
        this.store.transitionAttempt(workflowAttemptId, "completed");
        const text = turn.response ?? "";
        if (options.schema === undefined) {
          this.store.finishAttemptAndStep(workflowAttemptId, "completed", "completed", { output: text });
          return text;
        }
        let parsed: JsonValue;
        try { parsed = parseStructuredOutput(text); }
        catch { parsed = text; }
        const validation = await validateStructuredOutput(options.schema, parsed, {
          maxBytes: this.config.limits.schemaBytes,
          maxDepth: this.config.limits.schemaDepth,
        });
        if (validation.valid && validation.value !== undefined) {
          this.store.finishAttemptAndStep(workflowAttemptId, "completed", "completed", { output: validation.value });
          return validation.value;
        }
        schemaAttempts += 1;
        if (schemaAttempts >= 5) break;
        if (capabilities.correctionAuthority === "unsupported") break;
      }
      const error = workflowFailure("SCHEMA_VALIDATION_FAILED", "Agent output did not match the requested schema.");
      this.store.transitionStep(live.step.id, "failed", { error });
      throw error;
    } finally {
      context.active.activeAttempts -= 1;
      this.refreshActiveClock(context.active);
      if (createdWorktree && this.inspectWorktree) {
        try {
          const inspection = await this.inspectWorktree({ runId: context.run.id, stepId: live.step.id,
            scope, worktree: createdWorktree });
          this.store.updateStepWorktree(live.step.id, {
            workspaceId: createdWorktree.workspaceId, path: createdWorktree.workspaceRoot,
            baseSha: createdWorktree.baseSha, changed: inspection.changed,
          });
        } catch (error) {
          this.store.updateStepWorktree(live.step.id, {
            workspaceId: createdWorktree.workspaceId, path: createdWorktree.workspaceRoot,
            baseSha: createdWorktree.baseSha, changed: true,
          });
          this.store.appendEvent(context.run.id, "warning", {
            code: "WORKTREE_INSPECTION_FAILED", message: errorMessage(error),
          }, live.step.id);
        }
      }
      if (context.active.pauseRequested && context.active.activeAttempts === 0) this.changeRun(context.run.id, "paused", "Paused by user.");
    }
  }

  private async nested(context: RuntimeContext, request: WorkflowNestedRequest, bridge: WorkflowBridgeContext): Promise<WorkflowBridgeReply> {
    if (context.depth >= 1) throw workflowFailure("NESTING_LIMIT", "Nested workflows are limited to one child level.");
    const definition = typeof request.reference === "string"
      ? await this.resolveNestedName(context, request.reference)
      : await this.registry.resolvePath(context.scope.workspaceRoot, request.reference.scriptPath,
          context.run.sourcePath ? dirname(context.run.sourcePath) : context.scope.workspaceRoot);
    await preflightWorkflowScript(definition.parsed, { limits: runtimeLimits(this.config) });
    const requestObject = { reference: request.reference as JsonValue, argsPresent: request.argsPresent,
      args: request.args ?? null, phase: request.phase ?? null } as unknown as JsonObject;
    const requestHash = hash(canonicalJson(requestObject));
    const replay = context.active.replay;
    let prior: WorkflowStepRecord | undefined;
    if (replay && !replay.live) {
      const candidate = replay.prefix[replay.index];
      if (candidate?.kind === "workflow" && candidate.requestHash === requestHash
        && candidate.deliverySequence !== undefined) {
        prior = candidate;
        replay.index += 1;
      } else divergeReplay(replay);
    }
    const step = this.store.createStep({ runId: context.run.id, parentStepId: context.parentStepId, kind: "workflow",
      logicalPath: `${context.depth}:${bridge.requestId}`, requestHash, request: requestObject,
      phase: request.phase, label: definition.meta.name, workspaceId: context.scope.workspaceId });
    context.active.stepsByRequest.set(requestKey(context, bridge.requestId), step.id);
    this.store.transitionStep(step.id, "running");
    const childRun: WorkflowRunRecord = { ...context.run, argsPresent: request.argsPresent, args: request.args,
      scriptSource: definition.source, scriptHash: definition.sourceHash, sourcePath: definition.sourcePath,
      meta: definition.meta as unknown as JsonObject };
    try {
      const release = await this.nestedScheduler.acquire(context.active.controller.signal);
      try {
      const result = await this.execute({ run: childRun, active: context.active, script: definition.parsed,
        scope: context.scope, depth: 1, parentStepId: step.id, replayParentStepId: prior?.id });
      this.store.transitionStep(step.id, "completed", { output: result.result });
      if (prior && replay) {
        replay.priorByNewStep.set(step.id, prior.id);
        await waitForReplayDelivery(replay, prior.id);
      }
      return { value: result.result, budget: this.budget(context.run), replayed: prior !== undefined && !replay?.live };
      } finally { release(); }
    } catch (error) {
      this.store.transitionStep(step.id, "failed", { error: toWorkflowError(error, context.run.id, step.id) });
      throw error;
    }
  }

  private async resolveNestedName(context: RuntimeContext, name: string) {
    context.active.workflowDiscovery ??= this.registry.discover(context.scope.workspaceRoot);
    const definition = (await context.active.workflowDiscovery).definitions.find((item) => item.name === name);
    if (!definition) throw new Error(`WORKFLOW_NOT_FOUND: ${name}`);
    return definition;
  }

  private runtimeEvent(context: RuntimeContext, event: WorkflowRuntimeEvent): void {
    context.active.eventCount += 1;
    if (context.active.eventCount > this.config.limits.eventsPerRun) {
      throw workflowFailure("LOG_LIMIT", "The workflow event limit was reached.");
    }
    if (event.type === "log") {
      context.active.logBytes += Buffer.byteLength(event.message, "utf8");
      if (context.active.logBytes > this.config.limits.logTotalBytes) {
        throw workflowFailure("LOG_LIMIT", "The workflow log limit was reached.");
      }
    }
    if ((event.type === "phase" || event.type === "log") && event.replayed) {
      this.store.appendEvent(context.run.id, event.type, event as unknown as JsonObject, context.parentStepId);
      this.notify(context.run.id);
      return;
    }
    if (event.type === "replay_diverged") {
      if (context.active.replay) divergeReplay(context.active.replay);
      this.store.appendEvent(context.run.id, event.type, event as unknown as JsonObject, context.parentStepId);
    } else if (event.type === "delivery") {
      const stepId = context.active.stepsByRequest.get(requestKey(context, event.requestId));
      if (stepId) {
        this.store.recordDelivery(stepId, event.deliverySequence);
        const live = context.active.liveSteps.get(stepId);
        if (live) {
          live.delivered = true;
          context.active.liveSteps.delete(stepId);
        }
        const replay = context.active.replay;
        const priorId = replay?.priorByNewStep.get(stepId);
        if (replay && priorId === replay.deliveryOrder[replay.deliveryIndex]?.id) {
          replay.deliveryIndex += 1;
          replay.priorByNewStep.delete(stepId);
          pumpReplayDelivery(replay);
        }
      }
    } else {
      if (event.type === "budget_observation" && !event.replayed && context.active.replay) {
        divergeReplay(context.active.replay);
      }
      const payload = event.type === "phase"
        ? { type: event.type, title: event.title }
        : event.type === "log"
          ? { type: event.type, message: event.message }
          : event;
      this.store.appendEvent(context.run.id, event.type, payload as unknown as JsonObject, context.parentStepId);
    }
    this.notify(context.run.id);
  }

  private recordExternalEvent(context: RuntimeContext, type: string, payload: JsonObject, stepId?: string): void {
    context.active.eventCount += 1;
    if (context.active.eventCount > this.config.limits.eventsPerRun) {
      throw workflowFailure("LOG_LIMIT", "The workflow event limit was reached.");
    }
    const textBytes = [payload.text, payload.summary, payload.description]
      .reduce<number>((total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), 0);
    context.active.logBytes += textBytes;
    if (context.active.logBytes > this.config.limits.logTotalBytes) {
      throw workflowFailure("LOG_LIMIT", "The workflow log limit was reached.");
    }
    this.store.appendEvent(context.run.id, type, payload, stepId);
  }

  private pauseGate(active: ActiveRun): Promise<void> {
    if (active.controller.signal.aborted) return Promise.reject(active.controller.signal.reason);
    if (!active.pauseRequested) return Promise.resolve();
    return new Promise((resolvePause, rejectPause) => {
      const done = () => {
        active.controller.signal.removeEventListener("abort", abort);
        active.pauseWaiters.delete(done);
        resolvePause();
      };
      const abort = () => {
        active.pauseWaiters.delete(done);
        rejectPause(active.controller.signal.reason);
      };
      active.controller.signal.addEventListener("abort", abort, { once: true });
      active.pauseWaiters.add(done);
    });
  }

  private async usageGate(context: RuntimeContext): Promise<void> {
    let waiting = false;
    try {
      while (context.active.usageNotBefore > Date.now()) {
        if (!waiting) {
          waiting = true;
          context.active.waitingUsageAttempts += 1;
          this.refreshActiveClock(context.active);
        }
        await abortableDelay(context.active.usageNotBefore - Date.now(), context.active.controller.signal);
      }
    } finally {
      if (waiting) {
        context.active.waitingUsageAttempts -= 1;
        this.refreshActiveClock(context.active);
      }
    }
    if (context.active.usageNotBefore !== 0) {
      context.active.usageNotBefore = 0;
      this.store.setNextEligibleAt(context.run.id);
      const run = this.store.getRun(context.run.id);
      if (run?.state === "waiting_for_usage") {
        this.changeRun(context.run.id, context.active.pauseRequested ? "paused" : "running",
          context.active.pauseRequested ? "Paused by user." : undefined);
      }
    }
  }

  private refreshActiveClock(active: ActiveRun): void {
    const parkedForPause = active.pauseRequested && active.activeAttempts === 0;
    const parkedForUsage = active.activeAttempts > 0
      && active.waitingUsageAttempts === active.activeAttempts;
    active.activeClock.setSuspended(parkedForPause || parkedForUsage);
  }

  private async cancelOwned(active: ActiveRun): Promise<boolean> {
    const turns = [...active.liveSteps.values()].filter((step) => step.turn && !step.delivered);
    if (!turns.length) return true;
    const cancellation = Promise.all(turns.map(async (step) => {
      const turn = step.turn!;
      const stopped = await this.agents.stop(turn.agentId, turn.id, step.scope);
      if (stopped.isErr()) return false;
      return stopped.value.status === "stopped"
        || stopped.value.status === "completed"
        || stopped.value.status === "failed";
    })).then((settled) => settled.every(Boolean));
    return new Promise((resolveCancellation) => {
      const timer = setTimeout(() => resolveCancellation(false), 10_000);
      timer.unref();
      void cancellation.then((confirmed) => {
        clearTimeout(timer);
        resolveCancellation(confirmed);
      });
    });
  }

  private budget(run: WorkflowRunRecord): WorkflowBudgetSnapshot {
    const budget = this.store.getBudget(run.budgetId);
    return { total: budget.totalOutputTokens, knownSpent: budget.knownOutputTokens, complete: budget.usageComplete };
  }

  private async exportRunArtifacts(run: WorkflowRunRecord): Promise<{
    journal: { id: string; path: string; bytes: number };
    result?: { id: string; path: string; bytes: number };
  }> {
    const events = [];
    let after = 0;
    while (events.length < this.config.limits.eventsPerRun) {
      const page = this.store.listEvents(run.id, after,
        Math.min(1_000, this.config.limits.eventsPerRun - events.length));
      if (!page.length) break;
      events.push(...page);
      after = page.at(-1)!.sequence;
      if (page.length < 1_000) break;
    }
    const lines = events.map((event) => JSON.stringify(event));
    if (after < run.revision) lines.push(JSON.stringify({ runId: run.id, sequence: after,
      type: "export_truncated", payload: { limit: this.config.limits.eventsPerRun } }));
    const journalText = lines.join("\n") + (lines.length ? "\n" : "");
    const journal = await this.writeExport(run, "journal.jsonl", journalText);
    if (run.result === undefined) {
      this.store.setResultArtifactId(run.id, journal.id);
      return { journal };
    }
    const result = await this.writeExport(run, "result.json", `${JSON.stringify(run.result)}\n`);
    this.store.setResultArtifactId(run.id, result.id);
    return { journal, result };
  }

  private async exportStepOutput(run: WorkflowRunRecord, step: WorkflowStepRecord): Promise<{
    id: string; path: string; bytes: number;
  } | undefined> {
    if (step.output === undefined) return undefined;
    return this.writeExport(run, `step-${step.id}.json`, `${JSON.stringify(step.output)}\n`);
  }

  private async writeExport(
    run: WorkflowRunRecord, filename: string, contents: string,
  ): Promise<{ id: string; path: string; bytes: number }> {
    const canonicalRoot = await realpath(run.workspaceRoot);
    const directory = await resolvePathInsideCanonicalRoot(
      join(".devspace", "workflows", "runs", run.id), run.workspaceRoot, run.workspaceRoot, canonicalRoot,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = await resolvePathInsideCanonicalRoot(join(directory, filename), canonicalRoot, canonicalRoot, canonicalRoot);
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
    return { id: `workflow:${run.id}:${filename}`, path, bytes: Buffer.byteLength(contents, "utf8") };
  }

  private async snapshot(run: WorkflowRunRecord, afterRevision = 0): Promise<JsonObject> {
    const counts = this.store.countSteps(run.id);
    const budget = this.store.getBudget(run.budgetId);
    const steps = this.store.listStepSummaries(run.id);
    const journalEvents = this.store.listEvents(run.id, afterRevision, 1_000);
    const events = journalEvents.filter((event) => event.payload.replayed !== true);
    const eventsThroughRevision = journalEvents.at(-1)?.sequence ?? Math.min(afterRevision, run.revision);
    const eventsTruncated = eventsThroughRevision < run.revision;
    let exports: Awaited<ReturnType<WorkflowManager["exportRunArtifacts"]>> | undefined;
    let exportWarning: JsonObject | undefined;
    if (TERMINAL_STATES.has(run.state)) {
      try { exports = run.resultArtifactId
        ? await this.existingRunArtifacts(run)
        : await this.exportRunArtifacts(run); }
      catch (error) { exportWarning = { code: "ARTIFACT_EXPORT_FAILED", message: errorMessage(error) }; }
    }
    const largeResult = run.result !== undefined && jsonByteLength(run.result) > 64 * 1024;
    const phases = new Map<string, { id: string; title: string; running: number; completed: number; failed: number }>();
    for (const step of steps) {
      if (!step.phase) continue;
      const phase = phases.get(step.phase) ?? { id: hash(step.phase).slice(0, 12), title: step.phase, running: 0, completed: 0, failed: 0 };
      if (["queued", "starting", "running", "waiting_for_permission", "waiting_for_usage"].includes(step.state)) phase.running++;
      else if (["completed", "cached"].includes(step.state)) phase.completed++;
      else phase.failed++;
      phases.set(step.phase, phase);
    }
    return compactJson({
      runId: run.id,
      workflowName: stringValue(run.meta.name) ?? "workflow",
      resumedFromRunId: run.resumedFromRunId,
      state: run.state,
      revision: run.revision,
      nextEventRevision: eventsThroughRevision,
      eventsTruncated,
      counts,
      usage: {
        outputTokens: budget.usageComplete ? budget.knownOutputTokens : null,
        knownOutputTokens: budget.knownOutputTokens,
        complete: budget.usageComplete,
        budgetTotal: budget.totalOutputTokens,
        remaining: budget.totalOutputTokens === null || !budget.usageComplete
          ? null : Math.max(0, budget.totalOutputTokens - budget.knownOutputTokens),
        scope: "workflow_lineage",
      },
      phases: [...phases.values()],
      result: largeResult ? undefined : run.result,
      resultPreview: largeResult ? jsonPreview(run.result!) : undefined,
      resultArtifact: largeResult ? exports?.result : undefined,
      error: run.error,
      pauseReason: run.pauseReason,
      nextEligibleAt: run.nextEligibleAt,
      partial: counts.failed + counts.stopped > 0
        || this.store.hasPartialExecution(run.id),
      warnings: exportWarning ? [exportWarning] : [],
      worktrees: steps.filter((step) => step.worktree).map((step) => ({
        stepId: step.id, label: step.label, state: step.state, workspaceId: step.workspaceId,
        ...(step.worktree ?? {}),
      })),
      transcript: exports ? { directory: dirname(exports.journal.path), journal: exports.journal } : undefined,
      events,
    } as unknown as JsonObject);
  }

  private async existingRunArtifacts(run: WorkflowRunRecord): Promise<{
    journal: { id: string; path: string; bytes: number };
    result?: { id: string; path: string; bytes: number };
  }> {
    const journal = await this.exportReference(run, "journal.jsonl");
    const result = run.result === undefined ? undefined : await this.exportReference(run, "result.json");
    return { journal, ...(result ? { result } : {}) };
  }

  private async exportReference(run: WorkflowRunRecord, filename: string): Promise<{
    id: string; path: string; bytes: number;
  }> {
    const canonicalRoot = await realpath(run.workspaceRoot);
    const path = await resolvePathInsideCanonicalRoot(
      join(".devspace", "workflows", "runs", run.id, filename),
      canonicalRoot, canonicalRoot, canonicalRoot,
    );
    const { size } = await stat(path);
    return { id: `workflow:${run.id}:${filename}`, path, bytes: size };
  }

  private changeRun(
    runId: string, state: WorkflowState, reason?: string, result?: JsonValue,
    omittedResult?: boolean, error?: WorkflowError,
  ): void {
    const run = this.store.getRun(runId);
    if (!run || (TERMINAL_STATES.has(run.state) && run.state === state)) return;
    this.store.transitionRun(runId, state, { reason, error, ...(result !== undefined ? { result } : {}), omittedResult });
    this.notify(runId);
  }

  private notify(runId: string): void {
    for (const notify of this.revisionWaiters.get(runId) ?? []) notify();
    this.revisionWaiters.delete(runId);
  }

  private requireRun(scope: WorkflowScope, runId: string): WorkflowRunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw workflowFailure("WORKFLOW_NOT_FOUND", `Unknown workflow run: ${runId}`);
    if (run.workspaceId !== scope.workspaceId || run.workspaceRoot !== scope.workspaceRoot) {
      throw workflowFailure("WORKSPACE_MISMATCH", "The workflow belongs to another workspace.");
    }
    return run;
  }

  private async resolveSource(
    scope: WorkflowScope,
    input: Extract<WorkflowRequest, { operation: "run" }>["input"],
  ): Promise<{ parsed: ParsedWorkflowScript; path?: string }> {
    if (input.scriptPath) {
      const definition = await this.registry.resolvePath(scope.workspaceRoot, input.scriptPath);
      return { parsed: definition.parsed, path: definition.sourcePath };
    }
    if (input.name) {
      const definition = await this.registry.resolveName(scope.workspaceRoot, input.name);
      return { parsed: definition.parsed, path: definition.sourcePath };
    }
    if (!input.script) throw workflowFailure("WORKFLOW_SOURCE_INVALID", "A workflow source is required.");
    return { parsed: parseWorkflowScript(input.script, { maxBytes: this.config.limits.scriptBytes }) };
  }
}

export function createWorkflowManager(options: WorkflowManagerOptions): WorkflowManager {
  return new WorkflowManager(options);
}

class ActiveTimeClock {
  private remainingMs: number;
  private activeSince = performance.now();
  private activeTimer?: ReturnType<typeof setTimeout>;
  private readonly hardTimer: ReturnType<typeof setTimeout>;
  private suspended = false;
  private expired = false;
  private readonly waiters = new Set<() => void>();

  constructor(activeLimitMs: number, hardLimitMs: number) {
    this.remainingMs = activeLimitMs;
    this.hardTimer = setTimeout(() => this.expire(), Math.min(hardLimitMs, 2_147_483_647));
    this.hardTimer.unref();
    this.arm();
  }

  setSuspended(suspended: boolean): void {
    if (this.expired || suspended === this.suspended) return;
    if (suspended) {
      this.remainingMs -= performance.now() - this.activeSince;
      if (this.activeTimer) clearTimeout(this.activeTimer);
      this.activeTimer = undefined;
      this.suspended = true;
    } else {
      this.suspended = false;
      this.activeSince = performance.now();
      this.arm();
    }
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.expired) return Promise.resolve();
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolveWait, rejectWait) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(done);
        resolveWait();
      };
      const abort = () => {
        this.waiters.delete(done);
        rejectWait(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(done);
    });
  }

  dispose(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    clearTimeout(this.hardTimer);
    this.waiters.clear();
  }

  private arm(): void {
    if (this.expired || this.suspended) return;
    if (this.remainingMs <= 0) {
      this.expire();
      return;
    }
    this.activeTimer = setTimeout(() => this.expire(), this.remainingMs);
    this.activeTimer.unref();
  }

  private expire(): void {
    if (this.expired) return;
    if (!this.suspended) this.remainingMs -= performance.now() - this.activeSince;
    this.expired = true;
    if (this.activeTimer) clearTimeout(this.activeTimer);
    clearTimeout(this.hardTimer);
    for (const resolveWait of this.waiters) resolveWait();
    this.waiters.clear();
  }
}

class FairScheduler {
  private readonly queues = new Map<string, Array<{ run: () => Promise<JsonValue>; resolve: (value: JsonValue) => void; reject: (error: unknown) => void }>>();
  private order: string[] = [];
  private cursor = 0;
  private active = 0;

  constructor(private readonly limit: number) {}

  schedule(runId: string, run: () => Promise<JsonValue>): Promise<JsonValue> {
    return new Promise((resolveTask, rejectTask) => {
      const queue = this.queues.get(runId) ?? [];
      queue.push({ run, resolve: resolveTask, reject: rejectTask });
      this.queues.set(runId, queue);
      if (!this.order.includes(runId)) this.order.push(runId);
      this.drain();
    });
  }

  cancelRun(runId: string): void {
    const queue = this.queues.get(runId) ?? [];
    for (const item of queue) item.reject(workflowFailure("WORKFLOW_STOPPED", "Workflow stopped."));
    this.queues.delete(runId);
    this.order = this.order.filter((id) => id !== runId);
  }

  wake(): void { this.drain(); }

  private drain(): void {
    while (this.active < this.limit && this.order.length) {
      if (this.cursor >= this.order.length) this.cursor = 0;
      const runId = this.order[this.cursor]!;
      const queue = this.queues.get(runId);
      const item = queue?.shift();
      if (!item) {
        this.queues.delete(runId);
        this.order.splice(this.cursor, 1);
        continue;
      }
      this.cursor = (this.cursor + 1) % this.order.length;
      if (!queue?.length) {
        this.queues.delete(runId);
        this.order = this.order.filter((id) => id !== runId);
        if (this.cursor >= this.order.length) this.cursor = 0;
      }
      this.active++;
      void item.run().then(item.resolve, item.reject).finally(() => { this.active--; this.drain(); });
    }
  }
}

class AbortableSemaphore {
  private active = 0;
  private readonly waiting: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolveAcquire, rejectAcquire) => {
      const entry = { signal, resolve: resolveAcquire, reject: rejectAcquire };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        rejectAcquire(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      entry.resolve = (release) => {
        signal.removeEventListener("abort", abort);
        resolveAcquire(release);
      };
      this.waiting.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift()!;
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      this.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}

function runtimeLimits(config: WorkflowsConfig): Partial<WorkflowRuntimeLimits> {
  return { ...config.limits, maxAgents: config.maxAgentsPerRun, maxAttempts: config.maxAttemptsPerRun };
}

function replayState(prefix: WorkflowStepRecord[]): ReplayState {
  return {
    prefix,
    index: 0,
    live: false,
    deliveryOrder: prefix.filter((step) => step.deliverySequence !== undefined)
      .sort((left, right) => left.deliverySequence! - right.deliverySequence!),
    deliveryIndex: 0,
    waiting: new Map(),
    priorByNewStep: new Map(),
  };
}

function waitForReplayDelivery(replay: ReplayState, priorStepId: string): Promise<void> {
  if (replay.live) return Promise.resolve();
  return new Promise((resolveDelivery) => {
    replay.waiting.set(priorStepId, resolveDelivery);
    pumpReplayDelivery(replay);
  });
}

function divergeReplay(replay: ReplayState): void {
  replay.live = true;
  for (const step of replay.deliveryOrder.slice(replay.deliveryIndex)) replay.waiting.get(step.id)?.();
  replay.waiting.clear();
  replay.priorByNewStep.clear();
}

function pumpReplayDelivery(replay: ReplayState): void {
  const next = replay.deliveryOrder[replay.deliveryIndex];
  if (!next) return;
  replay.waiting.get(next.id)?.();
  replay.waiting.delete(next.id);
}

function requestKey(context: RuntimeContext, requestId: number): string {
  return `${context.depth}:${context.parentStepId ?? "root"}:${requestId}`;
}

function policySnapshot(config: WorkflowsConfig): JsonObject {
  return JSON.parse(JSON.stringify(config)) as JsonObject;
}

function phaseModel(script: ParsedWorkflowScript, phase?: string): string | undefined {
  return phase ? script.meta.phases?.find((item) => item.title === phase)?.model : undefined;
}

function schemaRepairPrompt(schema: unknown): string {
  return `Return only corrected JSON matching this schema. Do not repeat tools or other work.\n${JSON.stringify(schema)}`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); rejectDelay(signal.reason); };
    function done() { signal.removeEventListener("abort", abort); resolveDelay(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function stringValue(value: JsonValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function jsonByteLength(value: JsonValue): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function jsonPreview(value: JsonValue): string { return boundedText(JSON.stringify(value), 4 * 1024); }
function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return Buffer.from(marker).subarray(0, maxBytes).toString("utf8").replace(/�$/u, "");
  const prefix = Buffer.from(value).subarray(0, maxBytes - markerBytes).toString("utf8").replace(/�$/u, "");
  return `${prefix}${marker}`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`; }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function compactJson(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}

function workflowFailure(code: string, message: string, retryable = false): WorkflowError {
  return { code, message, layer: "workflow", retryable };
}

function toWorkflowError(error: unknown, runId?: string, stepId?: string): WorkflowError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const input = error as { code: unknown; message: unknown; layer?: unknown; retryable?: unknown; provider?: unknown; agentId?: unknown };
    return compactJson({ code: String(input.code), message: String(input.message),
      layer: typeof input.layer === "string" ? input.layer : "workflow", retryable: input.retryable === true,
      runId, stepId, provider: input.provider, agentId: input.agentId }) as unknown as WorkflowError;
  }
  return { code: "WORKFLOW_FAILED", message: error instanceof Error ? error.message : String(error),
    layer: "workflow", retryable: false, runId, stepId };
}

function encodeCursor(run: WorkflowRunRecord): string {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id })).toString("base64url");
}

function decodeCursor(cursor?: string): { updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: unknown; id?: unknown };
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string") throw new Error();
    return { updatedAt: value.updatedAt, id: value.id };
  } catch { throw workflowFailure("WORKFLOW_SOURCE_INVALID", "Invalid workflow cursor."); }
}
