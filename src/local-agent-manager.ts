import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentProviderCancelledError,
  AgentProviderUnavailableError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  createLocalAgentTurnId,
  MAX_TURN_EVENT_BYTES,
  MAX_TURN_EVENTS,
  providerErrorDetail,
  sanitizeActivityEvent,
  type LocalAgentTurnEvent,
  type LocalAgentTurnEventBody,
} from "./local-agent-events.js";
import {
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import { localAgentCancelledError } from "./local-agent-cancellation.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import type { LocalAgentDriverKind } from "./local-agent-provider.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  LocalAgentDispatchConflictError,
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentTurnRecord,
  type LocalAgentTurnStatus,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";
import {
  isSubagentProviderEnabled,
  subagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  agentId?: string;
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

// Kept below the client's default request deadline so a slow stop is reported as a conflict, not a daemon timeout.
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  authorizeManagedWorkspace?: (workspaceRoot: string, workspaceId: string) => boolean;
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig;
  stopTimeoutMs?: number;
  /** Preflight for a provider's executable, so a missing one fails the request instead of the turn. */
  providerAvailability?: (providerInstanceId: string) => LocalAgentProviderAvailability;
}

export type AgentStartError =
  | AgentTargetError
  | AgentScopeError
  | AgentConflictError
  | AgentStoreError
  | AgentProviderUnavailableError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;
export type AgentWaitError = AgentLookupError;
export type AgentStopError = AgentLookupError | AgentConflictError;
export type AgentEventsError = AgentLookupError;

export interface LocalAgentFailure {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}

export type LocalAgentWaitResult = { turnId?: string } & (
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: LocalAgentFailure }
  | { id: string; status: "stopped"; error?: LocalAgentFailure }
);

export interface LocalAgentTurnEventsQuery {
  /** Defaults to the agent's latest turn. */
  turnId?: string;
  afterSeq?: number;
}

export interface LocalAgentTurnEvents {
  agentId: string;
  turnId: string;
  status: LocalAgentTurnStatus;
  events: LocalAgentTurnEvent[];
}

interface ActiveLocalAgentTurn {
  turnRowId: number;
  completion: Promise<void>;
  abortController: AbortController;
}

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<string, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly authorizeManagedWorkspace?: (workspaceRoot: string, workspaceId: string) => boolean;
  private readonly logger?: LocalAgentManagerLogger;
  private readonly subagents: SubagentsConfig;
  private readonly stopTimeoutMs: number;
  private readonly providerAvailability?: (providerInstanceId: string) => LocalAgentProviderAvailability;
  private readonly activeTurns = new Map<string, ActiveLocalAgentTurn>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.providerInstanceId, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.authorizeManagedWorkspace = options.authorizeManagedWorkspace;
    this.logger = options.logger;
    this.subagents = options.subagents;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.providerAvailability = options.providerAvailability;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    return this.store.reconcileActiveRunsResult(message);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
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
          message: `Unknown subagent profile or provider: ${input.target}.${
            manager.subagents.enabled ? "" : " Subagents are disabled by subagents.enabled in config."
          }`,
        }));
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
      yield* manager.providerAvailableResult(target.provider, driver, "start");
      const createdResult = manager.store.createResult({
        id: input.agentId,
        workspaceId: input.workspaceId,
        workspaceRoot,
        profileName: target.name,
        providerInstanceId: target.provider,
        driver: driver.provider,
        model: target.model,
        effort: target.effort,
        writeMode: input.writeMode ?? "allowed",
        dispatchSignature: dispatchSignature(input, workspaceRoot, target.model, target.effort),
      });
      if (
        createdResult.isErr()
        && createdResult.error.cause instanceof LocalAgentDispatchConflictError
      ) {
        return Result.err(dispatchConflict(input.agentId ?? "unknown"));
      }
      const created = yield* createdResult;
      // An idempotent retry of a workflow dispatch returns the existing agent.
      if (!created.created) return Result.ok(created.record);
      return manager.begin(created.record, input.prompt, {
        model: target.model,
        effort: target.effort,
        writeMode: input.writeMode,
      }, input.workspaceId);
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      yield* manager.writeModeResult(record, overrides.writeMode);
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      yield* manager.profileForRecordResult(record, profiles);
      yield* manager.providerEnabledResult(record.providerInstanceId, record.profileName, "continue");
      const driver = yield* manager.driverResult(record.providerInstanceId, "continue", agentId, record.driver);
      yield* manager.providerAvailableResult(record.providerInstanceId, driver, "continue", agentId);
      return manager.begin(record, prompt, overrides, scope.workspaceId);
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

  getTurn(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentLookupError> {
    const agent = this.get(agentId, scope);
    if (agent.isErr()) return agent;
    return this.store.getLatestTurnResult(agentId);
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
      if (active?.turnRowId !== capture.turn.id) {
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

  events(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
    query: LocalAgentTurnEventsQuery = {},
  ): BetterResult<LocalAgentTurnEvents, AgentEventsError> {
    const agent = this.get(agentId, scope);
    if (agent.isErr()) return agent;
    const lookup = query.turnId
      ? this.store.getTurnByTurnIdResult(query.turnId)
      : this.store.getLatestTurnResult(agentId);
    if (lookup.isErr()) return lookup;
    const turn = lookup.value;
    if (!turn || turn.agentId !== agentId) {
      return Result.err(new AgentTargetError({
        code: "AGENT_NOT_FOUND",
        target: agentId,
        retryable: false,
        message: query.turnId
          ? `Unknown turn ${query.turnId} for subagent ${agentId}.`
          : `Subagent ${agentId} has no turns.`,
      }));
    }
    return this.store.listTurnEventsResult(turn, query.afterSeq).map((events) => ({
      agentId,
      turnId: turn.turnId,
      status: turn.status,
      events,
    }));
  }

  async stop(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentStopError>> {
    const record = this.get(agentId, scope);
    if (record.isErr()) return record;
    if (record.value.status === "stopped") return Result.ok(record.value);
    const active = this.activeTurns.get(agentId);
    if (!active) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "stop",
        retryable: false,
        message: `Agent ${agentId} does not have a running turn.`,
      }));
    }
    const driver = this.drivers.get(record.value.providerInstanceId);
    if (!driver?.capabilities.turns.interrupt) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "stop",
        retryable: false,
        message: `Agent ${agentId} provider does not support stopping an active turn.`,
      }));
    }
    active.abortController.abort();
    const settled = await this.settledWithin(active.completion, this.stopTimeoutMs);
    const refreshed = this.get(agentId, scope);
    if (refreshed.isErr() || refreshed.value.status === "stopped") return refreshed;
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation: "stop",
      retryable: !settled,
      message: settled
        ? `Agent ${agentId} finished before it could be stopped.`
        : `Agent ${agentId} did not stop within ${this.stopTimeoutMs}ms; its turn is still running.`,
    }));
  }

  private async settledWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      return await Promise.race([completion.then(() => true as const, () => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
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

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError> {
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
      turnId: createLocalAgentTurnId(),
      prompt,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
      writeMode: overrides.writeMode ?? record.writeMode,
    });
    if (begun.isErr()) return begun;
    const events = new TurnEventLog(this.store, begun.value.turn, (fields) => (
      this.log("warn", "agent_turn_event_failed", { agentId: record.id, ...fields })
    ));
    events.record({ type: "turn_started" });
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const abortController = new AbortController();
    const turn = Promise.resolve().then(() => (
      this.runTurn(
        begun.value.agent,
        begun.value.turn,
        events,
        prompt,
        overrides,
        workspaceId,
        abortController.signal,
      )
    ));
    this.activeTurns.set(record.id, {
      turnRowId: begun.value.turn.id,
      completion: turn,
      abortController,
    });
    void turn.catch(() => undefined);
    return Result.ok(begun.value.agent);
  }

  private async runTurn(
    record: LocalAgentRecord,
    turn: LocalAgentTurnRecord,
    events: TurnEventLog,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    const turnId = turn.id;
    const persistRunError = (error: LocalAgentError) => this.persistRunError(record, turnId, events, error, startedAt);
    this.log("info", "agent_run_started", {
      providerInstanceId: record.providerInstanceId,
      driver: record.driver,
      agentId: record.id,
      turnId: turn.turnId,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        persistRunError(authorized.error);
        return;
      }
      const workspaceRoot = authorized.value;
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        persistRunError(profiles.error);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        persistRunError(profile.error);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        persistRunError(input.error);
        return;
      }
      const driver = this.driverResult(record.providerInstanceId, "run", record.id, record.driver);
      if (driver.isErr()) {
        persistRunError(driver.error);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        providerInstanceId: record.providerInstanceId,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        effort: input.value.effort,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onSessionId: (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId === providerSessionId) return;
          const updated = this.store.updateResult(record.id, { providerSessionId });
          if (updated.isErr()) throw updated.error;
        },
        onEvent: (event) => events.recordActivity(event),
      };
      // A stop that lands while the turn is still queued must not launch a provider runtime.
      if (signal?.aborted) {
        persistRunError(localAgentCancelledError(driver.value.provider, "run"));
        return;
      }
      const result = await this.pool.run(driver.value, context, { ...input.value, signal }, callbacks);
      if (result.isErr()) {
        persistRunError(result.error);
        return;
      }
      const runResult = result.value;
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      events.record({ type: "turn_completed", status: "completed" });
      const updated = this.store.finishTurnResult(record.id, turnId, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        status: "completed",
        response: runResult.finalResponse,
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        providerInstanceId: updated.value.providerInstanceId,
        driver: updated.value.driver,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      if (isLocalAgentError(error)) {
        persistRunError(error);
        return;
      }
      events.record({ type: "turn_completed", status: "failed", errorCode: "AGENT_INTERNAL_ERROR" });
      const persisted = this.store.finishTurnResult(record.id, turnId, {
        status: "failed",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        providerInstanceId: record.providerInstanceId,
        driver: record.driver,
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
    events: TurnEventLog,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const stopped = AgentProviderCancelledError.is(error);
    const status = stopped ? "stopped" : "failed";
    events.record({ type: "turn_completed", status, errorCode: error.code });
    const persisted = this.store.finishTurnResult(record.id, turnId, {
      status,
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
      errorDetail: stopped ? undefined : providerErrorDetail(error),
    });
    this.log(stopped ? "info" : "error", stopped ? "agent_run_stopped" : "agent_run_failed", {
      providerInstanceId: record.providerInstanceId,
      driver: record.driver,
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
    const isRawProvider = record.profileName === record.providerInstanceId;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: record.providerInstanceId,
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
      writeMode: overrides.writeMode ?? record.writeMode,
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
    });
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    // Profiles win over provider instances of the same name, matching start-time target resolution.
    // A same-name profile for another provider instance would not match the runtime that executes the turn.
    const profile = profiles.find(
      (candidate) => candidate.name === record.profileName && candidate.provider === record.providerInstanceId,
    );
    if (!profile && record.profileName === record.providerInstanceId) return Result.ok(undefined);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: record.providerInstanceId,
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
    providerInstanceId: string,
    operation: string,
    agentId?: string,
    expectedDriver?: LocalAgentDriverKind,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    const driver = this.drivers.get(providerInstanceId);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? providerInstanceId,
        provider: providerInstanceId,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider instance: ${providerInstanceId}.`,
      }));
    }
    if (expectedDriver && driver.provider !== expectedDriver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? providerInstanceId,
        provider: providerInstanceId,
        operation,
        retryable: false,
        message: `Provider instance ${providerInstanceId} now uses ${driver.provider}; this agent was created with ${expectedDriver}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    providerInstanceId: string,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    const configured = subagentProviderConfig(this.subagents, providerInstanceId);
    if (!configured) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target,
        provider: providerInstanceId,
        operation,
        retryable: false,
        message: `Subagent provider instance is not configured: ${providerInstanceId}.`,
      }));
    }
    if (isSubagentProviderEnabled(this.subagents, providerInstanceId)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider: providerInstanceId,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${providerInstanceId}.`,
    }));
  }

  private providerAvailableResult(
    providerInstanceId: string,
    driver: LocalAgentDriver,
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentProviderUnavailableError> {
    const availability = this.providerAvailability?.(providerInstanceId);
    if (!availability || availability.available) return Result.ok(undefined);
    return Result.err(new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: driver.provider,
      agentId,
      operation,
      retryable: true,
      message: `${providerInstanceId} provider is not available: ${availability.reason ?? "provider preflight failed"}.`,
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
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      // Workflow-managed workspaces live outside the allowed roots; the owner vouches for them.
      if (workspaceId) {
        try {
          if (this.authorizeManagedWorkspace?.(normalized, workspaceId)) return Result.ok(normalized);
        } catch {
          // Preserve the original containment failure below.
        }
      }
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private writeModeResult(
    record: LocalAgentRecord,
    requested: LocalAgentWriteMode | undefined,
  ): BetterResult<void, AgentConflictError> {
    if (!requested || writeModeRank(requested) <= writeModeRank(record.writeMode)) {
      return Result.ok(undefined);
    }
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId: record.id,
      operation: "continue",
      retryable: false,
      message: `Subagent ${record.id} cannot expand write authority from ${record.writeMode} to ${requested}.`,
    }));
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
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
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

/**
 * Appends one turn's events to the store within fixed count and size bounds.
 * The last slot is reserved so a follower always sees turn_completed.
 */
class TurnEventLog {
  private seq = 0;
  private bytes = 0;
  private dropped = 0;
  private completed = false;

  constructor(
    private readonly store: LocalAgentStore,
    private readonly turn: LocalAgentTurnRecord,
    private readonly warn: (fields: Record<string, unknown>) => void,
  ) {}

  recordActivity(event: Parameters<NonNullable<LocalAgentRunCallbacks["onEvent"]>>[0]): void {
    try {
      const sanitized = sanitizeActivityEvent(event);
      if (sanitized) this.record(sanitized);
    } catch (error) {
      // Visibility must never fail the turn it observes.
      this.warn({ turnId: this.turn.turnId, error: errorMessage(error) });
    }
  }

  record(event: LocalAgentTurnEventBody): void {
    if (this.completed) return;
    const terminal = event.type === "turn_completed";
    this.completed = terminal;
    const body = terminal && this.dropped > 0 ? { ...event, droppedEvents: this.dropped } : event;
    const size = JSON.stringify(body).length;
    if (!terminal && (this.seq >= MAX_TURN_EVENTS - 1 || this.bytes + size > MAX_TURN_EVENT_BYTES)) {
      this.dropped += 1;
      return;
    }
    this.seq += 1;
    this.bytes += size;
    const appended = this.store.appendTurnEventResult(this.turn, this.seq, body, new Date().toISOString());
    if (appended.isErr()) this.warn({ turnId: this.turn.turnId, error: appended.error.message });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function dispatchConflict(agentId: string): AgentConflictError {
  return new AgentConflictError({
    code: "AGENT_CONFLICT",
    agentId,
    operation: "start",
    retryable: false,
    message: `Subagent id ${agentId} is already owned by a different dispatch.`,
  });
}

function writeModeRank(writeMode: LocalAgentWriteMode): number {
  switch (writeMode) {
    case "read_only": return 0;
    case "allowed": return 1;
    case "full_access": return 2;
  }
}

function dispatchSignature(
  input: StartLocalAgentInput,
  workspaceRoot: string,
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!input.agentId) return undefined;
  return createHash("sha256").update(JSON.stringify([
    input.workspaceId ?? null,
    workspaceRoot,
    input.target,
    input.prompt,
    model ?? null,
    effort ?? null,
    input.writeMode ?? "allowed",
  ])).digest("hex");
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
  return { ...waitBodyFromTurn(turn, timedOut), turnId: turn.turnId };
}

function waitBodyFromTurn(turn: LocalAgentTurnRecord, timedOut: boolean): LocalAgentWaitResult {
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
  const body = waitBodyFromAgent(agent, timedOut);
  return agent.latestTurnId ? { ...body, turnId: agent.latestTurnId } : body;
}

function waitBodyFromAgent(agent: LocalAgentRecord, timedOut: boolean): LocalAgentWaitResult {
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
          ...(agent.errorDetail ? { detail: agent.errorDetail } : {}),
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

function turnFailure(turn: LocalAgentTurnRecord): LocalAgentFailure {
  return {
    code: turn.errorCode ?? "AGENT_FAILED",
    message: turn.error ?? "Subagent failed without an error message.",
    retryable: turn.errorRetryable ?? false,
    ...(turn.errorDetail ? { detail: turn.errorDetail } : {}),
  };
}
