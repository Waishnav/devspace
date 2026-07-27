import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { WorkflowSandboxApi } from "./workflow-sandbox.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  LocalAgentResolutionError,
  resolveLocalAgentExecution,
} from "./local-agent-resolution.js";
import type { JsonSchema, JsonValue } from "./json-types.js";
import { jsonValueSchema } from "./json-types.js";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_MAX_AGENT_CALLS,
  WORKFLOW_MAX_ITEMS,
  WORKFLOW_MAX_NEST_DEPTH,
  buildAgentCacheKeyInput,
  createStubBudget,
  type AgentIsolationMode,
  type AgentCacheKeyInput,
  type AgentOpts,
  type AppendWorkflowEventInput,
  type WorkflowMeta,
} from "./workflow-types.js";
import { agentOptsSchema } from "./workflow-contracts.js";
import { WorkflowEngineError } from "./workflow-errors.js";

export { WorkflowEngineError } from "./workflow-errors.js";

// ---------------------------------------------------------------------------
// Host deps (injected by engine; fakes OK in tests)
// ---------------------------------------------------------------------------

export interface WorkflowProviderRunInput {
  provider: LocalAgentProvider;
  prompt: string;
  providerSessionId?: string;
  model?: string;
  effort?: string;
  workspace: string;
  signal?: AbortSignal;
  label?: string;
  phase?: string;
  /** JSON Schema for native structured output (codex/claude). */
  schema?: JsonSchema;
}

export interface WorkflowProviderRunResult {
  finalResponse: string;
  providerSessionId?: string;
  /** Provider-native structured object when schema was requested. */
  structured?: unknown;
}

export type WorkflowRunProvider = (
  input: WorkflowProviderRunInput,
) => Promise<WorkflowProviderRunResult>;

export interface WorkflowWorktreeHandle {
  path: string;
  /** Called after agent returns or fails. Success+clean may remove; dirty/failure preserves. */
  finalize: (outcome: "success" | "failure") => Promise<{ dirty: boolean; removed: boolean }>;
}

export type CreateAgentWorktree = (input: {
  runId: string;
  callIndex: number;
  workspaceRoot: string;
  baseSha?: string;
}) => Promise<WorkflowWorktreeHandle>;

export interface WorkflowReplayHit {
  value: JsonValue;
  responseText?: string;
  structuredJson?: string;
  returnValueJson: string;
  providerSessionId?: string;
  replayMatch: "same_index";
  replayedFromRunId: string;
  replayedFromCallIndex: number;
}

export interface WorkflowReplayMiss {
  reason:
    | "no_compatible_call"
    | "prior_call_not_replayable"
    | "compatible_result_consumed"
    | "identity_changed"
    | "prefix_diverged"
    | "worktree_not_restored"
    | "result_not_persisted"
    | "stored_result_invalid";
  changedFields?: Array<keyof AgentCacheKeyInput>;
}

export type WorkflowReplayDecision =
  | { hit: WorkflowReplayHit; miss?: never }
  | { hit?: never; miss: WorkflowReplayMiss };

export interface WorkflowReplay {
  decide(
    callIndex: number,
    cacheKey: string,
    input: AgentCacheKeyInput,
  ): WorkflowReplayDecision;
}

export interface WorkflowJournal {
  appendEvent<K extends AppendWorkflowEventInput["type"]>(
    input: Extract<AppendWorkflowEventInput, { type: K }>,
  ): unknown;
  startAgentCall(input: {
    runId: string;
    callIndex: number;
    cacheKey: string;
    prompt: string;
    schemaJson?: string;
    provider: LocalAgentProvider;
    model?: string;
    effort?: string;
    profileName?: string;
    profileFingerprint?: string;
    label?: string;
    phase?: string;
    isolation?: AgentIsolationMode;
    worktreePath?: string;
    replayMatch?: "same_index";
    replayedFromRunId?: string;
    replayedFromCallIndex?: number;
    replayReason?: string;
  }): unknown;
  cacheAgentCall(input: {
    runId: string;
    callIndex: number;
    cacheKey: string;
    prompt: string;
    schemaJson?: string;
    provider: LocalAgentProvider;
    model?: string;
    effort?: string;
    profileName?: string;
    profileFingerprint?: string;
    label?: string;
    phase?: string;
    isolation?: AgentIsolationMode;
    replayMatch: "same_index";
    replayedFromRunId: string;
    replayedFromCallIndex: number;
    responseText?: string;
    structuredJson?: string;
    returnValueJson?: string;
    providerSessionId?: string;
  }): unknown;
  completeAgentCall(input: {
    runId: string;
    callIndex: number;
    responseText?: string;
    structuredJson?: string;
    returnValueJson?: string;
    providerSessionId?: string;
    dirty?: boolean;
    worktreePath?: string;
    fromCache?: boolean;
  }): unknown;
  failAgentCall(input: {
    runId: string;
    callIndex: number;
    error: string;
    errorKind?: import("./workflow-types.js").WorkflowErrorKind;
    worktreePath?: string;
    dirty?: boolean;
    cleanupError?: string;
  }): unknown;
  isCancelRequested(runId: string): boolean;
}

export interface WorkflowApiDeps {
  runId: string;
  journal: WorkflowJournal;
  meta: WorkflowMeta;
  args: JsonValue | undefined;
  concurrency: number;
  signal: AbortSignal;
  workspaceRoot: string;
  baseSha?: string;
  /** Currently available provider ids in stable preference order. */
  availableProviders: LocalAgentProvider[];
  /** Loaded profiles available to this project. */
  agentProfiles?: LocalAgentProfile[];
  runProvider: WorkflowRunProvider;
  createWorktree?: CreateAgentWorktree;
  replay?: WorkflowReplay;
  /** Nested workflow source loader; required for workflow(). */
  resolveNestedSource?: (nameOrRef: string | { scriptPath: string }) => string | Promise<string>;
  /** Run a nested script sharing semaphore/callIndex. */
  executeNested?: (input: {
    source: string;
    args: JsonValue | undefined;
    nestDepth: number;
  }) => Promise<unknown>;
  nestDepth?: number;
  runtime?: WorkflowApiRuntime;
}

export interface WorkflowApi extends WorkflowSandboxApi {
  getCallCount(): number;
  getNestDepth(): number;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

export class WorkflowSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error("WorkflowSemaphore limit must be >= 1");
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelledError();
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(cancelledError());
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface WorkflowApiRuntime {
  semaphore: WorkflowSemaphore;
  callIndex: number;
}

export function createWorkflowApiRuntime(concurrency: number): WorkflowApiRuntime {
  return {
    semaphore: new WorkflowSemaphore(Math.max(1, concurrency)),
    callIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// API factory
// ---------------------------------------------------------------------------

const phaseAls = new AsyncLocalStorage<string>();

export function createWorkflowApi(deps: WorkflowApiDeps): WorkflowApi {
  const nestDepth = deps.nestDepth ?? 0;
  const runtime = deps.runtime ?? createWorkflowApiRuntime(deps.concurrency);
  const semaphore = runtime.semaphore;

  const agent = async (prompt: unknown, opts: unknown = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new WorkflowEngineError("internal", "agent(prompt) requires a non-empty string");
    }
    const agentOpts = normalizeAgentOpts(opts);
    throwIfCancelled(deps);

    const target = resolveAgentTarget(prompt, agentOpts, deps);
    const {
      provider,
      model,
      effort,
      profileName,
      profileFingerprint,
      providerPrompt,
    } = target;
    const phase = agentOpts.phase ?? phaseAls.getStore();
    const isolation: AgentIsolationMode =
      agentOpts.isolation === "worktree" ? "worktree" : "shared";
    const index = allocateAgentCallIndex(runtime);

    const cacheKeyInput = buildAgentCacheKeyInput({
      prompt,
      profileName,
      profileFingerprint,
      provider,
      model,
      effort,
      schema: agentOpts.schema,
      isolation,
    });
    const cacheKey = hashCacheKey(cacheKeyInput);

    const replayDecision = deps.replay?.decide(index, cacheKey, cacheKeyInput);
    if (replayDecision?.hit) {
      const hit = replayDecision.hit;
      deps.journal.cacheAgentCall({
        runId: deps.runId,
        callIndex: index,
        cacheKey,
        prompt,
        schemaJson: agentOpts.schema ? JSON.stringify(agentOpts.schema) : undefined,
        provider,
        model,
        effort,
        profileName,
        profileFingerprint,
        label: agentOpts.label,
        phase,
        isolation,
        replayMatch: hit.replayMatch,
        replayedFromRunId: hit.replayedFromRunId,
        replayedFromCallIndex: hit.replayedFromCallIndex,
        responseText: hit.responseText,
        structuredJson: hit.structuredJson,
        returnValueJson: hit.returnValueJson,
        providerSessionId: hit.providerSessionId,
      });
      return hit.value;
    }

    await semaphore.acquire(deps.signal);
    let worktree: WorkflowWorktreeHandle | null = null;
    let worktreePath: string | undefined;
    let agentCallBegun = false;
    try {
      throwIfCancelled(deps);

      deps.journal.startAgentCall({
        runId: deps.runId,
        callIndex: index,
        cacheKey,
        prompt,
        schemaJson: agentOpts.schema ? JSON.stringify(agentOpts.schema) : undefined,
        provider,
        model,
        effort,
        profileName,
        profileFingerprint,
        label: agentOpts.label,
        phase,
        isolation,
        replayReason: replayDecision?.miss
          ? formatReplayMiss(replayDecision.miss)
          : undefined,
      });
      agentCallBegun = true;

      if (isolation === "worktree") {
        if (!deps.createWorktree) {
          throw new WorkflowEngineError(
            "worktree",
            "isolation: 'worktree' requires createWorktree host support",
          );
        }
        worktree = await deps.createWorktree({
          runId: deps.runId,
          callIndex: index,
          workspaceRoot: deps.workspaceRoot,
          baseSha: deps.baseSha,
        });
        worktreePath = worktree.path;
        deps.journal.appendEvent({
          runId: deps.runId,
          type: "worktree_created",
          phase,
          label: agentOpts.label,
          data: { callIndex: index, worktreePath, isolation },
        });
      }

      const cwd = worktreePath ?? deps.workspaceRoot;
      const providerBase = {
        provider,
        prompt: providerPrompt,
        model,
        effort,
        workspace: cwd,
        signal: deps.signal,
        label: agentOpts.label,
        phase,
      };

      let returnValue: unknown;
      let structuredJson: string | undefined;
      let result: WorkflowProviderRunResult;

      if (agentOpts.schema) {
        // Lazy import keeps non-schema paths free of ajv load cost.
        const { enforceAgentSchema } = await import("./workflow-schema.js");
        const enforced = await enforceAgentSchema({
          schema: agentOpts.schema,
          prompt: providerPrompt,
          provider,
          run: (p, options) =>
            deps.runProvider({
              ...providerBase,
              prompt: p,
              providerSessionId: options.providerSessionId,
              ...(options.mode === "native" ? { schema: agentOpts.schema } : {}),
            }),
          onRetry: ({ attempt, errors, mode }) => {
            deps.journal.appendEvent({
              runId: deps.runId,
              type: "schema_retry",
              phase,
              label: agentOpts.label,
              data: { callIndex: index, attempt, errors, mode },
            });
          },
        });
        returnValue = enforced.value;
        structuredJson = JSON.stringify(enforced.value);
        result = {
          finalResponse: enforced.finalResponse,
          providerSessionId: enforced.providerSessionId,
          structured: enforced.value,
        };
      } else {
        result = await deps.runProvider(providerBase);
        returnValue = result.finalResponse;
      }

      throwIfCancelled(deps);

      const returnValueJson = serializeReplayValueOrThrow(returnValue);
      if (structuredJson !== undefined) {
        assertStructuredJsonBudget(structuredJson);
      }

      let dirty: boolean | undefined;
      if (worktree) {
        const finalized = await worktree.finalize("success");
        dirty = finalized.dirty;
        deps.journal.appendEvent({
          runId: deps.runId,
          type: "worktree_finalized",
          phase,
          label: agentOpts.label,
          data: {
            callIndex: index,
            worktreePath,
            dirty: finalized.dirty,
            removed: finalized.removed,
          },
        });
        worktree = null;
      }

      deps.journal.completeAgentCall({
        runId: deps.runId,
        callIndex: index,
        responseText: truncate(result.finalResponse, WORKFLOW_LIMITS.responseTextBytes),
        structuredJson,
        returnValueJson,
        providerSessionId: result.providerSessionId,
        dirty,
        worktreePath,
      });
      return returnValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleanupError: string | undefined;
      if (worktree) {
        try {
          const finalized = await worktree.finalize("failure");
          deps.journal.appendEvent({
            runId: deps.runId,
            type: "worktree_finalized",
            phase,
            label: agentOpts.label,
            data: {
              callIndex: index,
              worktreePath,
              dirty: finalized.dirty,
              removed: finalized.removed,
              outcome: "failure",
            },
          });
        } catch (cleanupFailure) {
          cleanupError =
            cleanupFailure instanceof Error
              ? cleanupFailure.message
              : String(cleanupFailure);
        }
      }
      if (agentCallBegun) {
        deps.journal.failAgentCall({
          runId: deps.runId,
          callIndex: index,
          error: message,
          errorKind: error instanceof WorkflowEngineError ? error.kind : "internal",
          worktreePath,
          cleanupError,
        });
      }
      throw error;
    } finally {
      semaphore.release();
    }
  };

  const parallel = async (...args: unknown[]): Promise<Array<unknown | null>> => {
    const thunks = args[0];
    if (!Array.isArray(thunks)) {
      throw new WorkflowEngineError("internal", "parallel(thunks) requires an array of functions");
    }
    assertMaxItems(thunks.length, "parallel");
    return Promise.all(
      thunks.map(async (thunk, index) => {
        if (typeof thunk !== "function") {
          throw new WorkflowEngineError(
            "internal",
            `parallel thunks[${index}] must be a function`,
          );
        }
        try {
          return await (thunk as () => Promise<unknown>)();
        } catch {
          return null;
        }
      }),
    );
  };

  const pipeline = async (...args: unknown[]): Promise<Array<unknown | null>> => {
    const items = args[0];
    const stages = args.slice(1);
    if (!Array.isArray(items)) {
      throw new WorkflowEngineError("internal", "pipeline(items, ...stages) requires an items array");
    }
    assertMaxItems(items.length, "pipeline");
    for (let i = 0; i < stages.length; i += 1) {
      if (typeof stages[i] !== "function") {
        throw new WorkflowEngineError("internal", `pipeline stage[${i}] must be a function`);
      }
    }
    return Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = item;
        for (const stage of stages) {
          try {
            prev = await (stage as (prev: unknown, item: unknown, index: number) => unknown)(
              prev,
              item,
              index,
            );
          } catch {
            return null;
          }
        }
        return prev;
      }),
    );
  };

  const phase = (...args: unknown[]): void => {
    const title = args[0];
    if (typeof title !== "string" || !title.trim()) {
      throw new WorkflowEngineError("internal", "phase(title) requires a non-empty string");
    }
    // In-process tests still use host ALS. Sandbox scripts track phase in the
    // child and inject opts.phase / log payloads across IPC.
    phaseAls.enterWith(title);
    deps.journal.appendEvent({
      runId: deps.runId,
      type: "phase_started",
      phase: title,
      data: { title },
    });
  };

  const log = (...args: unknown[]): void => {
    let message: string;
    let phaseTitle = phaseAls.getStore();
    if (
      args.length === 1 &&
      args[0] &&
      typeof args[0] === "object" &&
      !Array.isArray(args[0]) &&
      "message" in (args[0] as object)
    ) {
      const payload = args[0] as { message?: unknown; phase?: unknown };
      message = String(payload.message ?? "");
      if (typeof payload.phase === "string" && payload.phase.trim()) {
        phaseTitle = payload.phase;
      }
    } else {
      message = args.map(String).join(" ");
    }
    deps.journal.appendEvent({
      runId: deps.runId,
      type: "log",
      phase: phaseTitle,
      data: { message: truncate(message, WORKFLOW_LIMITS.eventDataJsonBytes) },
    });
  };

  const workflow = async (...args: unknown[]): Promise<unknown> => {
    if (nestDepth >= WORKFLOW_MAX_NEST_DEPTH) {
      throw new WorkflowEngineError(
        "nest_depth",
        `workflow() nesting limited to ${WORKFLOW_MAX_NEST_DEPTH} level`,
      );
    }
    if (!deps.resolveNestedSource || !deps.executeNested) {
      throw new WorkflowEngineError("internal", "nested workflow() is not configured on this host");
    }
    const nameOrRef = args[0] as string | { scriptPath: string };
    const childArgsResult = jsonValueSchema.optional().safeParse(args[1]);
    if (!childArgsResult.success) {
      throw new WorkflowEngineError(
        "internal",
        `workflow() args must be JSON-serializable: ${childArgsResult.error.issues[0]?.message ?? "invalid value"}`,
      );
    }
    const source = await deps.resolveNestedSource(nameOrRef);
    return deps.executeNested({
      source,
      args: childArgsResult.data,
      nestDepth: nestDepth + 1,
    });
  };

  return {
    agent: agent as WorkflowSandboxApi["agent"],
    parallel: parallel as WorkflowSandboxApi["parallel"],
    pipeline: pipeline as WorkflowSandboxApi["pipeline"],
    phase: phase as WorkflowSandboxApi["phase"],
    log: log as WorkflowSandboxApi["log"],
    args: deps.args,
    budget: createStubBudget(),
    workflow: workflow as WorkflowSandboxApi["workflow"],
    meta: deps.meta,
    getCallCount: () => runtime.callIndex,
    getNestDepth: () => nestDepth,
  };
}

function formatReplayMiss(miss: WorkflowReplayMiss): string {
  return miss.reason === "identity_changed" && miss.changedFields?.length
    ? `${miss.reason}:${miss.changedFields.join(",")}`
    : miss.reason;
}

/** Test helper: read current ALS phase (undefined outside phase). */
export function getCurrentWorkflowPhase(): string | undefined {
  return phaseAls.getStore();
}

export function hashCacheKey(input: ReturnType<typeof buildAgentCacheKeyInput>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

interface ResolvedAgentTarget {
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  profileName?: string;
  profileFingerprint?: string;
  providerPrompt: string;
}

function resolveAgentTarget(
  prompt: string,
  opts: AgentOpts,
  deps: Pick<WorkflowApiDeps, "agentProfiles" | "availableProviders" | "meta">,
): ResolvedAgentTarget {
  try {
    const resolved = resolveLocalAgentExecution({
      prompt,
      profile: opts.profile,
      provider: opts.provider,
      defaultProvider: deps.meta.defaultProvider,
      model: opts.model,
      effort: opts.effort,
      profiles: deps.agentProfiles ?? [],
      availableProviders: deps.availableProviders,
    });
    return {
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      profileName: resolved.profileName,
      profileFingerprint: resolved.profileFingerprint,
      providerPrompt: resolved.prompt,
    };
  } catch (error) {
    if (!(error instanceof LocalAgentResolutionError)) throw error;
    const kind = error.kind === "profile_not_found"
      ? "profile"
      : error.kind === "no_provider"
        ? "no_provider"
        : "provider_unavailable";
    throw new WorkflowEngineError(kind, error.message);
  }
}

function normalizeAgentOpts(opts: unknown): AgentOpts {
  if (opts === undefined || opts === null) return {};
  if (typeof opts === "object" && opts !== null && "writeMode" in opts) {
    throw new WorkflowEngineError("internal", "writeMode is not supported on agent() (v1)");
  }
  const parsed = agentOptsSchema.safeParse(opts);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "opts";
  const kind = path === "schema"
    ? "schema"
    : path === "isolation"
      ? "worktree"
      : path === "profile" || issue?.message.includes("profile and provider")
        ? "profile"
        : "internal";
  throw new WorkflowEngineError(
    kind,
    `Invalid agent ${path}: ${issue?.message ?? "validation failed"}`,
  );
}

function assertMaxItems(count: number, label: string): void {
  if (count > WORKFLOW_MAX_ITEMS) {
    throw new WorkflowEngineError(
      "internal",
      `${label} exceeds max items ${WORKFLOW_MAX_ITEMS} (got ${count})`,
    );
  }
}

function allocateAgentCallIndex(runtime: WorkflowApiRuntime): number {
  if (runtime.callIndex >= WORKFLOW_MAX_AGENT_CALLS) {
    throw new WorkflowEngineError(
      "call_limit",
      `Workflow exceeded the limit of ${WORKFLOW_MAX_AGENT_CALLS} agent calls`,
    );
  }
  const index = runtime.callIndex;
  runtime.callIndex += 1;
  return index;
}

function throwIfCancelled(deps: WorkflowApiDeps): void {
  if (deps.signal.aborted || deps.journal.isCancelRequested(deps.runId)) {
    throw cancelledError();
  }
}

function cancelledError(): WorkflowEngineError {
  return new WorkflowEngineError("cancelled", "Workflow cancelled");
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let end = Math.min(text.length, budget);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > budget) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

function assertStructuredJsonBudget(value: string): void {
  if (Buffer.byteLength(value, "utf8") <= WORKFLOW_LIMITS.structuredJsonBytes) return;
  throw new WorkflowEngineError(
    "result_too_large",
    `agent() structured result exceeds ${WORKFLOW_LIMITS.structuredJsonBytes} bytes; return a smaller object or write large artifacts to disk and return paths`,
  );
}

function serializeReplayValueOrThrow(value: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new WorkflowEngineError(
      "result_too_large",
      "agent() return value is not JSON-serializable and cannot be replayed",
    );
  }
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json, "utf8") <= WORKFLOW_LIMITS.replayValueJsonBytes) return json;
  throw new WorkflowEngineError(
    "result_too_large",
    `agent() return value exceeds ${WORKFLOW_LIMITS.replayValueJsonBytes} bytes replay budget; return a smaller summary or write large artifacts to disk and return paths`,
  );
}

/** Minimal JSON extract for schema path until Ajv module lands. */
export function tryExtractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // strip fenced block
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        // fall through
      }
    }
    const start = trimmed.search(/[{\[]/);
    if (start < 0) return undefined;
    const slice = trimmed.slice(start);
    try {
      return JSON.parse(slice);
    } catch {
      return undefined;
    }
  }
}
