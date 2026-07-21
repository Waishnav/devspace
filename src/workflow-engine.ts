import { availableParallelism } from "node:os";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { JsonValue } from "./json-types.js";
import { parseWorkflowScript, type ParsedWorkflowScript } from "./workflow-script.js";
import { runWorkflowSandbox } from "./workflow-sandbox.js";
import {
  createWorkflowApi,
  type CreateAgentWorktree,
  type WorkflowApi,
  type WorkflowJournal,
  type WorkflowReplay,
  type WorkflowRunProvider,
  WorkflowEngineError,
} from "./workflow-api.js";
import {
  WORKFLOW_HOST_TIMEOUT_MS,
  resolveWorkflowConcurrency,
  type WorkflowMeta,
  type WorkflowErrorKind,
} from "./workflow-types.js";

export interface ExecuteWorkflowOptions {
  /** Pre-parsed script, or pass `source` instead. */
  parsed?: ParsedWorkflowScript;
  source?: string;
  filename?: string;
  runId: string;
  journal: WorkflowJournal;
  args?: JsonValue;
  concurrency?: number;
  signal?: AbortSignal;
  workspaceRoot: string;
  baseSha?: string;
  enabledProviders: LocalAgentProvider[];
  runProvider: WorkflowRunProvider;
  createWorktree?: CreateAgentWorktree;
  replay?: WorkflowReplay;
  resolveNestedSource?: (nameOrRef: string | { scriptPath: string }) => string | Promise<string>;
  nestDepth?: number;
  timeoutMs?: number;
  /** Optional hooks after API construction (tests). */
  onApi?: (api: WorkflowApi) => void;
}

export interface ExecuteWorkflowResult {
  result: unknown;
  meta: WorkflowMeta;
  callCount: number;
}

/**
 * Execute one workflow script body (top-level or nested).
 * Does not create/claim/complete journal run rows — host/worker owns run lifecycle.
 */
export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const parsed =
    options.parsed ??
    parseWorkflowScript(options.source ?? "", { filename: options.filename });
  const nestDepth = options.nestDepth ?? 0;
  const signal = options.signal ?? new AbortController().signal;
  const concurrency =
    options.concurrency ??
    resolveWorkflowConcurrency(parsed.meta.concurrency, availableParallelism());

  const resolveNestedSource = options.resolveNestedSource;

  // Shared callIndex/semaphore for nested scripts via parent API path.
  const api = createWorkflowApi({
    runId: options.runId,
    journal: options.journal as WorkflowJournal,
    meta: parsed.meta,
    args: options.args,
    concurrency,
    signal,
    workspaceRoot: options.workspaceRoot,
    baseSha: options.baseSha,
    enabledProviders: options.enabledProviders,
    runProvider: options.runProvider,
    createWorktree: options.createWorktree,
    replay: options.replay,
    nestDepth,
    resolveNestedSource,
    executeNested: resolveNestedSource
      ? async (input) =>
          executeNestedOnApi({
            parentOptions: options,
            parentApi: api,
            source: input.source,
            args: input.args,
            nestDepth: input.nestDepth,
          })
      : undefined,
  });
  options.onApi?.(api);

  if (nestDepth === 0) {
    options.journal.appendEvent({
      runId: options.runId,
      type: "run_started",
      data: {
        name: parsed.meta.name,
        scriptHash: parsed.scriptHash,
        concurrency,
      },
    });
  }

  try {
    const result = await runWorkflowSandbox({
      parsed,
      api,
      timeoutMs: options.timeoutMs ?? WORKFLOW_HOST_TIMEOUT_MS,
    });
    return {
      result,
      meta: parsed.meta,
      callCount: api.getCallCount(),
    };
  } catch (error) {
    if (error instanceof WorkflowEngineError) {
      throw error;
    }
    throw error;
  }
}

/**
 * Nested script execution reusing parent's agent() call counter + semaphore
 * by constructing a child API that shares internal state via re-entry.
 *
 * Implementation: run child sandbox with a new API that has nestDepth+1 but
 * delegates agent/parallel/pipeline to the parent API (same callIndex).
 */
async function executeNestedOnApi(input: {
  parentOptions: ExecuteWorkflowOptions;
  parentApi: WorkflowApi;
  source: string;
  args: JsonValue | undefined;
  nestDepth: number;
}): Promise<unknown> {
  if (input.nestDepth > WORKFLOW_MAX_NEST_DEPTH_LOCAL) {
    throw new WorkflowEngineError(
      "nest_depth",
      `workflow() nesting limited to ${WORKFLOW_MAX_NEST_DEPTH_LOCAL} level`,
    );
  }
  const parsed = parseWorkflowScript(input.source, {
    filename: "workflow:nested",
  });

  // Child surface: reuse parent agent/parallel/pipeline/phase/log/budget/workflow
  // so callIndex + semaphore stay shared. Override args + meta for the child body.
  const childApi: WorkflowApi = {
    agent: input.parentApi.agent,
    parallel: input.parentApi.parallel,
    pipeline: input.parentApi.pipeline,
    phase: input.parentApi.phase,
    log: input.parentApi.log,
    args: input.args,
    budget: input.parentApi.budget,
    // Child workflow() must see nestDepth via a wrapper that throws at depth>1.
    workflow: async (...args: unknown[]) => {
      throw new WorkflowEngineError(
        "nest_depth",
        `workflow() nesting limited to ${WORKFLOW_MAX_NEST_DEPTH_LOCAL} level`,
      );
    },
    meta: parsed.meta,
    getCallCount: () => input.parentApi.getCallCount(),
    getNestDepth: () => input.nestDepth,
  };

  return runWorkflowSandbox({
    parsed,
    api: childApi,
    timeoutMs: input.parentOptions.timeoutMs ?? WORKFLOW_HOST_TIMEOUT_MS,
  });
}

const WORKFLOW_MAX_NEST_DEPTH_LOCAL = 1;

export function mapEngineErrorKind(error: unknown): WorkflowErrorKind {
  if (error instanceof WorkflowEngineError) {
    return error.kind;
  }
  if (error && typeof error === "object" && "name" in error) {
    const name = String((error as { name: string }).name);
    if (name === "WorkflowScriptError") {
      const kind = (error as { kind?: string }).kind;
      if (kind === "meta" || kind === "syntax" || kind === "script_too_large") {
        return kind;
      }
      return "syntax";
    }
    if (name === "WorkflowDeterminismError") return "determinism";
  }
  return "internal";
}
