import { availableParallelism } from "node:os";
import type {
  LocalAgentProfile,
  LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { JsonValue } from "./json-types.js";
import { parseWorkflowScript, type ParsedWorkflowScript } from "./workflow-script.js";
import { runWorkflowSandbox } from "./workflow-sandbox.js";
import {
  createWorkflowApi,
  createWorkflowApiRuntime,
  type CreateAgentWorktree,
  type WorkflowApi,
  type WorkflowApiRuntime,
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
import {
  isWorkflowOperationError,
  workflowErrorKind,
} from "./workflow-errors.js";

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
  availableProviders: LocalAgentProvider[];
  agentProfiles?: LocalAgentProfile[];
  runProvider: WorkflowRunProvider;
  createWorktree?: CreateAgentWorktree;
  replay?: WorkflowReplay;
  resolveNestedSource?: (nameOrRef: string | { scriptPath: string }) => string | Promise<string>;
  nestDepth?: number;
  timeoutMs?: number;
  /** Shared call counter/semaphore for nested workflow execution. */
  runtime?: WorkflowApiRuntime;
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
  const runtime = options.runtime ?? createWorkflowApiRuntime(concurrency);

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
    availableProviders: options.availableProviders,
    agentProfiles: options.agentProfiles,
    runProvider: options.runProvider,
    createWorktree: options.createWorktree,
    replay: options.replay,
    runtime,
    nestDepth,
    resolveNestedSource,
    executeNested: resolveNestedSource
      ? async (input) =>
          (
            await executeWorkflow({
              ...options,
              parsed: undefined,
              source: input.source,
              filename: "workflow:nested",
              args: input.args,
              signal,
              concurrency,
              runtime,
              nestDepth: input.nestDepth,
              onApi: undefined,
            })
          ).result
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
      signal,
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

export function mapEngineErrorKind(error: unknown): WorkflowErrorKind {
  if (error instanceof WorkflowEngineError) {
    return error.kind as WorkflowErrorKind;
  }
  if (isWorkflowOperationError(error)) {
    return workflowErrorKind(error);
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
