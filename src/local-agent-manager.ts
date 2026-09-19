import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type BegunLocalAgentTurn,
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentTurnRecord,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  localAgentCapabilities,
  type LocalAgentCapabilities,
  type LocalAgentDriver,
  type LocalAgentJsonSchema,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentToolPolicy,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";
import {
  isSubagentProviderEnabled,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  attemptId?: string;
  outputSchema?: LocalAgentJsonSchema;
  toolPolicy?: LocalAgentToolPolicy;
  workflowRunId?: string;
  workflowStepId?: string;
  workflowAttemptId?: string;
  expectedProfileHash?: string;
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  attemptId?: string;
  outputSchema?: LocalAgentJsonSchema;
  toolPolicy?: LocalAgentToolPolicy;
  workflowRunId?: string;
  workflowStepId?: string;
  workflowAttemptId?: string;
  expectedProfileHash?: string;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string, workspaceId?: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  validateWorkspaceScope?: (scope: LocalAgentWorkspaceScope, operation: string) => string;
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;
export type AgentWaitError = AgentLookupError;

export type LocalAgentWaitResult =
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: { code: string; message: string; retryable: boolean } }
  | { id: string; status: "stopped"; error?: { code: string; message: string; retryable: boolean } };

interface ActiveLocalAgentTurn {
  turnId: number;
  completion: Promise<void>;
  abort: AbortController;
}

export interface StartedLocalAgentTurn extends BegunLocalAgentTurn {
  capabilities: LocalAgentCapabilities;
}

export interface LocalAgentTurnCallbacks extends LocalAgentRunCallbacks {
  onPrepared?: (turn: BegunLocalAgentTurn) => void;
}

export interface LocalAgentInvocationResolution {
  target: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  writeMode: LocalAgentWriteMode;
  profileHash: string;
  capabilities: LocalAgentCapabilities;
}

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: LocalAgentManagerOptions["loadProfiles"];
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly validateWorkspaceScope?: LocalAgentManagerOptions["validateWorkspaceScope"];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly subagents: SubagentsConfig;
  private readonly activeTurns = new Map<string, ActiveLocalAgentTurn>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.validateWorkspaceScope = options.validateWorkspaceScope;
    this.logger = options.logger;
    this.subagents = options.subagents;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    return this.store.reconcileActiveRunsResult(message);
  }

  async capabilities(
    input: Pick<StartLocalAgentInput, "target" | "workspaceRoot" | "workspaceId" | "model" | "effort" | "writeMode" | "outputSchema" | "toolPolicy">,
  ): Promise<BetterResult<LocalAgentCapabilities, AgentStartError>> {
    const authorized = this.authorizeWorkspace(input.workspaceRoot, input.workspaceId, "capabilities");
    if (authorized.isErr()) return authorized;
    const profiles = await this.loadProfilesResult(authorized.value, input.target, input.workspaceId);
    if (profiles.isErr()) return profiles;
    const target = resolveLocalAgentTarget(input.target, profiles.value, input.model, input.effort, this.subagents.providers);
    if (!target) return Result.err(new AgentTargetError({
      code: "UNKNOWN_TARGET", target: input.target, retryable: false,
      message: `Unknown subagent profile or provider: ${input.target}.`,
    }));
    const enabled = this.providerEnabledResult(target.provider, target.name, "capabilities");
    if (enabled.isErr()) return enabled;
    const driver = this.driverResult(target.provider, "capabilities");
    if (driver.isErr()) return driver;
    const context: LocalAgentRuntimeContext = {
      agentId: "capability_probe", provider: driver.value.provider, workspaceRoot: authorized.value,
      writeMode: input.writeMode, model: target.model, effort: target.effort,
      outputSchema: input.outputSchema, toolPolicy: input.toolPolicy, agentDir: this.agentDir,
    };
    return Result.ok(localAgentCapabilities(driver.value, context, {
      prompt: "capability probe", workspaceRoot: authorized.value, model: target.model,
      effort: target.effort, outputSchema: input.outputSchema, toolPolicy: input.toolPolicy,
    }));
  }

  async resolveInvocation(
    input: Pick<StartLocalAgentInput, "target" | "workspaceRoot" | "workspaceId" | "model" | "effort" | "writeMode" | "outputSchema" | "toolPolicy">,
  ): Promise<BetterResult<LocalAgentInvocationResolution, AgentStartError>> {
    const authorized = this.authorizeWorkspace(input.workspaceRoot, input.workspaceId, "resolve");
    if (authorized.isErr()) return authorized;
    const profiles = await this.loadProfilesResult(authorized.value, input.target, input.workspaceId);
    if (profiles.isErr()) return profiles;
    const target = resolveLocalAgentTarget(input.target, profiles.value, input.model, input.effort, this.subagents.providers);
    if (!target) return Result.err(new AgentTargetError({ code: "UNKNOWN_TARGET", target: input.target,
      retryable: false, message: `Unknown subagent profile or provider: ${input.target}.` }));
    const enabled = this.providerEnabledResult(target.provider, target.name, "resolve");
    if (enabled.isErr()) return enabled;
    const driver = this.driverResult(target.provider, "resolve");
    if (driver.isErr()) return driver;
    const writeMode = narrowerWriteMode(input.writeMode ?? "allowed",
      target.kind === "profile" ? target.profile.writeMode ?? "allowed" : "allowed");
    const context: LocalAgentRuntimeContext = { agentId: "capability_probe", provider: target.provider,
      workspaceRoot: authorized.value, writeMode, model: target.model, effort: target.effort,
      outputSchema: input.outputSchema, toolPolicy: input.toolPolicy, agentDir: this.agentDir };
    return Result.ok({
      target: target.name,
      provider: target.provider,
      model: target.model,
      effort: target.effort,
      writeMode,
      profileHash: profileHash(target),
      capabilities: localAgentCapabilities(driver.value, context, { prompt: "capability probe",
        workspaceRoot: authorized.value, model: target.model, effort: target.effort,
        outputSchema: input.outputSchema, toolPolicy: input.toolPolicy }),
    });
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const started = await this.startTurn(input);
    return started.isErr() ? started : Result.ok(started.value.agent);
  }

  async startTurn(
    input: StartLocalAgentInput,
    callbacks: LocalAgentTurnCallbacks = {},
  ): Promise<BetterResult<StartedLocalAgentTurn, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target, input.workspaceId));
      const target = resolveLocalAgentTarget(
        input.target,
        profiles,
        input.model,
        input.effort,
        manager.subagents.providers,
      );
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (input.expectedProfileHash && input.expectedProfileHash !== profileHash(target)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: target.name,
          provider: target.provider, operation: "start", retryable: true,
          message: `Subagent profile changed after workflow admission: ${target.name}.` }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.providerEnabledResult(target.provider, target.name, "start");
      const driver = yield* manager.driverResult(target.provider, "start");
      const writeMode = narrowerWriteMode(input.writeMode ?? "allowed", target.kind === "profile"
        ? target.profile.writeMode ?? "allowed"
        : "allowed");
      const record = yield* manager.store.createResult({
        workspaceId: input.workspaceId,
        workspaceRoot,
        profileName: target.name,
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        writeMode,
      });
      return manager.beginTurn(record, input.prompt, {
        model: target.model,
        effort: target.effort,
        writeMode,
        attemptId: input.attemptId,
        outputSchema: input.outputSchema,
        toolPolicy: input.toolPolicy,
        workflowRunId: input.workflowRunId,
        workflowStepId: input.workflowStepId,
        workflowAttemptId: input.workflowAttemptId,
      }, input.workspaceId, callbacks, driver);
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const continued = await this.continueTurn(agentId, prompt, overrides, scope);
    return continued.isErr() ? continued : Result.ok(continued.value.agent);
  }

  async continueTurn(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
    callbacks: LocalAgentTurnCallbacks = {},
  ): Promise<BetterResult<StartedLocalAgentTurn, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName, record.workspaceId));
      const profile = yield* manager.profileForRecordResult(record, profiles);
      if (overrides.expectedProfileHash && overrides.expectedProfileHash !== recordProfileHash(record, profile)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
          provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
          operation: "continue", retryable: true,
          message: `Subagent profile changed after workflow admission: ${record.profileName}.` }));
      }
      yield* manager.providerEnabledResult(record.provider, record.profileName, "continue");
      const driver = yield* manager.driverResult(record.provider, "continue", agentId);
      return manager.beginTurn(record, prompt, {
        ...overrides,
        writeMode: narrowerWriteMode(record.writeMode ?? "allowed", overrides.writeMode ?? record.writeMode ?? "allowed"),
      }, scope.workspaceId, callbacks, driver);
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async wait(
    agentIds: readonly string[],
    scope: LocalAgentWorkspaceScope,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BetterResult<LocalAgentWaitResult[], AgentWaitError>> {
    const captures: Array<{ agent: LocalAgentRecord; turn?: LocalAgentTurnRecord }> = [];
    for (const agentId of unique(agentIds)) {
      const agent = this.get(agentId, scope);
      if (agent.isErr()) return agent;
      const turn = this.store.getLatestTurnResult(agentId);
      if (turn.isErr()) return turn;
      captures.push({ agent: agent.value, turn: turn.value });
    }

    const pending: Promise<void>[] = [];
    for (const capture of captures) {
      if (capture.turn?.status !== "running") continue;
      const active = this.activeTurns.get(capture.agent.id);
      if (active?.turnId !== capture.turn.id) {
        return Result.err(new AgentStoreError(
          "wait",
          new Error(`Turn ${capture.turn.id} is not active.`),
          `Running turn state is unavailable for subagent ${capture.agent.id}.`,
        ));
      }
      pending.push(active.completion);
    }

    const timedOut = pending.length > 0
      ? await waitForTurns(pending, timeoutMs, signal)
      : false;
    const results: LocalAgentWaitResult[] = [];
    for (const capture of captures) {
      if (!capture.turn) {
        results.push(waitResultFromAgent(capture.agent, timedOut));
        continue;
      }
      const turn = this.store.getTurnByIdResult(capture.turn.id);
      if (turn.isErr()) return turn;
      results.push(turn.value
        ? waitResultFromTurn(turn.value, timedOut)
        : waitResultFromAgent(capture.agent, timedOut));
    }
    return Result.ok(results);
  }

  async stop(
    agentId: string,
    turnId: number,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentTurnRecord, AgentWaitError>> {
    const agent = this.get(agentId, scope);
    if (agent.isErr()) return agent;
    const stored = this.store.getTurnByIdResult(turnId);
    if (stored.isErr()) return stored;
    if (!stored.value || stored.value.agentId !== agentId) return Result.err(agentNotFound(agentId));
    if (stored.value.status !== "running") return Result.ok(stored.value);
    const active = this.activeTurns.get(agentId);
    if (!active || active.turnId !== turnId) {
      return Result.err(new AgentStoreError(
        "stop",
        new Error(`Turn ${turnId} is not active.`),
        `Running turn state is unavailable for subagent ${agentId}.`,
      ));
    }
    active.abort.abort(new Error("Agent turn stopped."));
    await active.completion.catch(() => undefined);
    const finished = this.store.getTurnByIdResult(turnId);
    if (finished.isErr()) return finished;
    if (!finished.value) return Result.err(agentNotFound(agentId));
    return Result.ok(finished.value);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const turns = Array.from(this.activeTurns.values(), (turn) => turn.completion);
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private beginTurn(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    callbacks: LocalAgentTurnCallbacks = {},
    driver?: LocalAgentDriver,
  ): BetterResult<StartedLocalAgentTurn, AgentConflictError | AgentStoreError> {
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const begun = this.store.beginTurnResult(record.id, {
      prompt,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
      writeMode: overrides.writeMode ?? record.writeMode ?? "allowed",
      attemptId: overrides.attemptId,
      workflowRunId: overrides.workflowRunId,
      workflowStepId: overrides.workflowStepId,
      workflowAttemptId: overrides.workflowAttemptId,
    }, callbacks.onPrepared);
    if (begun.isErr()) return begun;
    const abort = new AbortController();
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = new Promise<void>((resolveTurn, rejectTurn) => {
      setImmediate(() => {
        void this.runTurn(
          begun.value.agent, begun.value.turn.id, prompt, overrides, workspaceId,
          { ...callbacks, onPrepared: undefined } as LocalAgentRunCallbacks, abort.signal,
        ).then(resolveTurn, rejectTurn);
      });
    });
    this.activeTurns.set(record.id, { turnId: begun.value.turn.id, completion: turn, abort });
    void turn.catch(() => undefined);
    const resolvedDriver = driver ?? this.drivers.get(record.provider as LocalAgentProvider);
    const capabilities = resolvedDriver ? localAgentCapabilities(resolvedDriver, {
      agentId: record.id,
      provider: resolvedDriver.provider,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: overrides.writeMode,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
      outputSchema: overrides.outputSchema,
      toolPolicy: overrides.toolPolicy,
      workflowRunId: overrides.workflowRunId,
      workflowStepId: overrides.workflowStepId,
      workflowAttemptId: overrides.workflowAttemptId,
      agentDir: this.agentDir,
    }, {
      prompt,
      workspaceRoot: record.workspaceRoot,
      attemptId: overrides.attemptId,
      outputSchema: overrides.outputSchema,
      toolPolicy: overrides.toolPolicy,
    }) : unavailableCapabilities();
    return Result.ok({ ...begun.value, capabilities });
  }

  private async runTurn(
    record: LocalAgentRecord,
    turnId: number,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    inputCallbacks: LocalAgentRunCallbacks = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        this.persistRunError(record, turnId, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName, workspaceId);
      if (profiles.isErr()) {
        this.persistRunError(record, turnId, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        this.persistRunError(record, turnId, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        this.persistRunError(record, turnId, input.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        this.persistRunError(record, turnId, driver.error, startedAt);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        effort: input.value.effort,
        outputSchema: input.value.outputSchema,
        toolPolicy: input.value.toolPolicy,
        workflowRunId: input.value.workflowRunId,
        workflowStepId: input.value.workflowStepId,
        workflowAttemptId: input.value.workflowAttemptId,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        ...inputCallbacks,
        onSessionId: async (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (current.value && current.value.providerSessionId !== providerSessionId) {
            const updated = this.store.updateResult(record.id, { providerSessionId });
            if (updated.isErr()) throw updated.error;
          }
          await inputCallbacks.onSessionId?.(providerSessionId);
        },
      };
      const result = await this.pool.run(driver.value, context, input.value, callbacks, signal ? { signal } : undefined);
      if (result.isErr()) {
        if (signal?.aborted && result.error.code === "PROVIDER_CANCELLED") {
          this.store.finishTurnResult(record.id, turnId, {
            status: "stopped",
            error: "Agent turn stopped.",
            errorCode: "AGENT_STOPPED",
            errorRetryable: false,
          });
          return;
        }
        this.persistRunError(record, turnId, result.error, startedAt);
        return;
      }
      const runResult = result.value;
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      const updated = this.store.finishTurnResult(record.id, turnId, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        status: "completed",
        response: runResult.structuredOutput === undefined
          ? runResult.finalResponse
          : JSON.stringify(runResult.structuredOutput),
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        provider: updated.value.provider,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      if (isLocalAgentError(error)) {
        this.persistRunError(record, turnId, error, startedAt);
        return;
      }
      const persisted = this.store.finishTurnResult(record.id, turnId, {
        status: "failed",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    } finally {
      this.activeTurns.delete(record.id);
    }
  }

  private persistRunError(
    record: LocalAgentRecord,
    turnId: number,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const persisted = this.store.finishTurnResult(record.id, turnId, {
      status: "failed",
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
      retryAfterMs: numericField(error, "retryAfterMs"),
      resetAt: stringField(error, "resetAt"),
      executionUncertain: booleanField(error, "executionUncertain"),
    });
    this.log("error", "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return Result.ok({
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: narrowerWriteMode(
        record.writeMode ?? "allowed",
        narrowerWriteMode(profile?.writeMode ?? "allowed", overrides.writeMode ?? record.writeMode ?? "allowed"),
      ),
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
      attemptId: overrides.attemptId,
      outputSchema: overrides.outputSchema,
      toolPolicy: overrides.toolPolicy,
      workflowRunId: overrides.workflowRunId,
      workflowStepId: overrides.workflowStepId,
      workflowAttemptId: overrides.workflowAttemptId,
    });
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === record.provider) return Result.ok(undefined);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    provider: string,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) return Result.ok(undefined);
    if (isSubagentProviderEnabled(this.subagents, provider)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${provider}.`,
    }));
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    workspaceId: string | undefined,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (workspaceId && this.validateWorkspaceScope) {
      try {
        return Result.ok(resolve(this.validateWorkspaceScope({ workspaceId, workspaceRoot: normalized }, operation)));
      } catch (cause) {
        return Result.err(new AgentScopeError({
          code: "WORKSPACE_NOT_ALLOWED", operation, retryable: false, cause,
          message: "Workspace root does not match its stored workspace identity.",
        }));
      }
    }
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
    if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
    workspaceId?: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot, workspaceId));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function narrowerWriteMode(left: LocalAgentWriteMode, right: LocalAgentWriteMode): LocalAgentWriteMode {
  const rank: Record<LocalAgentWriteMode, number> = { read_only: 0, allowed: 1, full_access: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function unavailableCapabilities(): LocalAgentCapabilities {
  return {
    cancellation: "unsupported",
    structuredOutput: "validated_text",
    usage: "unavailable",
    correctionAuthority: "unsupported",
    permissionRequests: "preconfigured",
    progress: "final_only",
  };
}

function numericField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
}

function stringField(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function booleanField(value: object, key: string): boolean | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function profileHash(target: NonNullable<ReturnType<typeof resolveLocalAgentTarget>>): string {
  return createHash("sha256").update(JSON.stringify(target.kind === "profile" ? target.profile : {
    name: target.name, provider: target.provider, model: target.model, effort: target.effort,
  })).digest("hex");
}

function recordProfileHash(record: LocalAgentRecord, profile: LocalAgentProfile | undefined): string {
  return createHash("sha256").update(JSON.stringify(profile ?? {
    name: record.profileName, provider: record.provider, model: record.model, effort: record.effort,
  })).digest("hex");
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function waitForTurns(
  turns: readonly Promise<void>[],
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = timeoutMs === undefined
    ? undefined
    : new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      });
  const aborted = signal
    ? new Promise<"aborted">((resolveAbort) => {
        onAbort = () => resolveAbort("aborted");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const result = await Promise.race([
      Promise.allSettled(turns).then(() => "completed" as const),
      ...(timeout ? [timeout] : []),
      ...(aborted ? [aborted] : []),
    ]);
    return result === "timeout";
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitResultFromTurn(turn: LocalAgentTurnRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (turn.status) {
    case "running":
      return { id: turn.agentId, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "completed":
      return {
        id: turn.agentId,
        status: "completed",
        ...(turn.response === undefined ? {} : { response: turn.response }),
      };
    case "failed":
      return { id: turn.agentId, status: "failed", error: turnFailure(turn) };
    case "stopped":
      return {
        id: turn.agentId,
        status: "stopped",
        ...(hasTurnFailure(turn) ? { error: turnFailure(turn) } : {}),
      };
  }
}

function waitResultFromAgent(agent: LocalAgentRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (agent.status) {
    case "starting":
    case "running":
      return { id: agent.id, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "idle":
      return {
        id: agent.id,
        status: "completed",
        ...(agent.latestResponse === undefined ? {} : { response: agent.latestResponse }),
      };
    case "error":
      return {
        id: agent.id,
        status: "failed",
        error: {
          code: agent.errorCode ?? "AGENT_FAILED",
          message: agent.error ?? "Subagent failed without an error message.",
          retryable: agent.errorRetryable ?? false,
        },
      };
    case "stopped":
      return {
        id: agent.id,
        status: "stopped",
        ...(agent.error || agent.errorCode || agent.errorRetryable !== undefined
          ? { error: {
              code: agent.errorCode ?? "AGENT_STOPPED",
              message: agent.error ?? "Subagent stopped.",
              retryable: agent.errorRetryable ?? false,
            } }
          : {}),
      };
  }
}

function hasTurnFailure(turn: LocalAgentTurnRecord): boolean {
  return turn.error !== undefined || turn.errorCode !== undefined || turn.errorRetryable !== undefined;
}

function turnFailure(turn: LocalAgentTurnRecord): { code: string; message: string; retryable: boolean } {
  return {
    code: turn.errorCode ?? "AGENT_FAILED",
    message: turn.error ?? "Subagent failed without an error message.",
    retryable: turn.errorRetryable ?? false,
  };
}
