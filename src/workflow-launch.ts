import { resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { parseJsonText, type JsonObject, type JsonValue } from "./json-types.js";
import {
  persistWorkflowScriptResult,
  readProjectWorkflowScriptFileResult,
  readWorkflowScriptFileResult,
  resolveNamedWorkflowScriptResult,
  resolveWorkflowScriptFromPathOrNameResult,
} from "./workflow-files.js";
import { parseWorkflowScript, WorkflowScriptError } from "./workflow-script.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkflowRunRecord, WorkflowRunSource } from "./workflow-types.js";
import {
  InvalidWorkflowInputError,
  WorkflowNotFoundError,
  WorkflowStoredDataError,
  isWorkflowOperationError,
  type WorkflowOperationError,
  type WorkflowFileWriteError,
} from "./workflow-errors.js";
import { resolveWorkspaceHead } from "./workflow-worktrees.js";
import { spawnWorkflowWorker } from "./workflow-worker.js";
import { Result, type Result as BetterResult } from "better-result";
import type { WorkflowRunTransitionError } from "./workflow-store.js";

export type LaunchWorkflowSource =
  | { kind: "inline"; script: string; filename?: string }
  | { kind: "file"; path: string }
  | { kind: "named"; name: string }
  | {
      kind: "resume";
      runId: string;
      /** Optional replacement source while resuming. */
      override?:
        | { kind: "inline"; script: string; filename?: string }
        | { kind: "file"; path: string }
        | { kind: "named"; name: string };
    };

export interface LaunchWorkflowRunInput {
  store: WorkflowStore;
  config: Pick<ServerConfig, "stateDir">;
  workspaceRoot: string;
  workspaceId?: string;
  source: LaunchWorkflowSource;
  args?: JsonValue;
  /** Local CLI paths or MCP paths constrained to the project's workflow directory. */
  scriptFileScope: "local" | "project-workflows";
  /** Absolute path to cli entry used to spawn `workflow __worker`. */
  cliEntry: string;
  /** When false, create the run row but do not spawn (tests). Default true. */
  spawn?: boolean;
}

export type LaunchWorkflowError =
  | WorkflowOperationError
  | WorkflowScriptError
  | WorkflowFileWriteError
  | WorkflowRunTransitionError;

export interface LaunchWorkflowRunResult {
  run: WorkflowRunRecord;
  parsedName: string;
  scriptHash: string;
  source: WorkflowRunSource;
}

/**
 * Shared CLI/MCP start path: resolve script → parse → create run → persist → spawn.
 */
export async function launchWorkflowRun(
  input: LaunchWorkflowRunInput,
): Promise<BetterResult<LaunchWorkflowRunResult, LaunchWorkflowError>> {
  try {
    const resolved = await resolveLaunchSource(input);
    if (resolved.isErr()) return Result.err(resolved.error);

    const {
      sourceText,
      scriptHash,
      nameHint,
      runSource,
      priorRunId,
      filename,
      args,
    } = resolved.value;

    const parsed = parseWorkflowScript(sourceText, { filename });
    const baseSha = await resolveWorkspaceHead(input.workspaceRoot);
    const preferredName = parsed.meta.name || nameHint;

    const run = input.store.createRun({
      name: preferredName,
      source: runSource,
      scriptPath: "pending",
      scriptHash,
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      argsJson: JSON.stringify(args === undefined ? null : args),
      resumedFromRunId: priorRunId,
      baseSha,
    });

    const persisted = await persistWorkflowScriptResult({
      stateDir: input.config.stateDir,
      runId: run.id,
      source: sourceText,
      preferredName,
    });
    if (persisted.isErr()) {
      failStartedRun(input.store, run.id, persisted.error);
      return Result.err(persisted.error);
    }

    const updated = input.store.setScriptPathResult(run.id, persisted.value);
    if (updated.isErr()) {
      failStartedRun(input.store, run.id, updated.error);
      return Result.err(updated.error);
    }

    if (input.spawn !== false) {
      try {
        await spawnWorkflowWorker(run.id, input.cliEntry);
      } catch (error) {
        failStartedRun(input.store, run.id, error);
        throw error;
      }
    }

    return Result.ok({
      run: updated.value,
      parsedName: preferredName,
      scriptHash,
      source: runSource,
    });
  } catch (error) {
    if (isLaunchError(error)) return Result.err(error);
    throw error;
  }
}

interface ResolvedLaunch {
  sourceText: string;
  scriptHash: string;
  nameHint: string;
  runSource: WorkflowRunSource;
  priorRunId?: string;
  filename: string;
  args: JsonValue | undefined;
}

async function resolveLaunchSource(
  input: LaunchWorkflowRunInput,
): Promise<BetterResult<ResolvedLaunch, LaunchWorkflowError>> {
  const { source, store, config, workspaceRoot } = input;
  let args = input.args;

  if (source.kind === "resume") {
    const priorResult = store.getRunResult(source.runId);
    if (priorResult.isErr()) return Result.err(priorResult.error);
    const prior = priorResult.value;
    if (!prior) return Result.err(new WorkflowNotFoundError(source.runId));
    if (!runBelongsToWorkspace(prior, input.workspaceId, workspaceRoot)) {
      return Result.err(new WorkflowNotFoundError(source.runId));
    }

    let sourceText: string;
    let scriptHash: string;
    let nameHint: string;
    let filename: string;

    if (source.override?.kind === "inline") {
      sourceText = source.override.script;
      const overrideParsed = parseWorkflowScript(sourceText, {
        filename: source.override.filename ?? "workflow:inline",
      });
      scriptHash = overrideParsed.scriptHash;
      nameHint = overrideParsed.meta.name;
      filename = source.override.filename ?? "workflow:inline";
    } else if (source.override?.kind === "named") {
      const named = await resolveNamedWorkflowScriptResult({
        name: source.override.name,
        workspaceRoot,
        stateDir: config.stateDir,
      });
      if (named.isErr()) return Result.err(named.error);
      sourceText = named.value.source;
      scriptHash = named.value.scriptHash;
      nameHint = named.value.nameHint;
      filename = named.value.scriptPath;
    } else if (source.override?.kind === "file") {
      const file = await resolveExplicitWorkflowFile(input, source.override.path);
      if (file.isErr()) return Result.err(file.error);
      sourceText = file.value.source;
      scriptHash = file.value.scriptHash;
      nameHint = file.value.nameHint;
      filename = file.value.scriptPath;
    } else {
      const priorScript = await readWorkflowScriptFileResult(prior.scriptPath);
      if (priorScript.isErr()) return Result.err(priorScript.error);
      sourceText = priorScript.value.source;
      scriptHash = priorScript.value.scriptHash;
      nameHint = prior.name;
      filename = prior.scriptPath;
    }

    if (args === undefined && prior.argsJson && prior.argsJson !== "null") {
      try {
        args = parseJsonText(prior.argsJson);
      } catch (cause) {
        return Result.err(new WorkflowStoredDataError(`${prior.id}.argsJson`, cause));
      }
    }

    return Result.ok({
      sourceText,
      scriptHash,
      nameHint,
      runSource: "resume",
      priorRunId: prior.id,
      filename,
      args,
    });
  }

  if (source.kind === "inline") {
    const parsed = parseWorkflowScript(source.script, {
      filename: source.filename ?? "workflow:inline",
    });
    return Result.ok({
      sourceText: source.script,
      scriptHash: parsed.scriptHash,
      nameHint: parsed.meta.name,
      runSource: "inline",
      filename: source.filename ?? "workflow:inline",
      args,
    });
  }

  if (source.kind === "named") {
    const named = await resolveNamedWorkflowScriptResult({
      name: source.name,
      workspaceRoot,
      stateDir: config.stateDir,
    });
    if (named.isErr()) return Result.err(named.error);
    return Result.ok({
      sourceText: named.value.source,
      scriptHash: named.value.scriptHash,
      nameHint: named.value.nameHint,
      runSource: "named",
      filename: named.value.scriptPath,
      args,
    });
  }

  if (source.kind === "file") {
    const file = await resolveExplicitWorkflowFile(input, source.path);
    if (file.isErr()) return Result.err(file.error);
    return Result.ok({
      sourceText: file.value.source,
      scriptHash: file.value.scriptHash,
      nameHint: file.value.nameHint,
      runSource: "file",
      filename: file.value.scriptPath,
      args,
    });
  }

  return Result.err(
    new InvalidWorkflowInputError({
      code: "missing_source",
      message: "Provide a workflow script source",
    }),
  );
}

function isLaunchError(error: unknown): error is LaunchWorkflowError {
  return error instanceof WorkflowScriptError || isWorkflowOperationError(error);
}

function resolveExplicitWorkflowFile(
  input: LaunchWorkflowRunInput,
  path: string,
) {
  if (input.scriptFileScope === "project-workflows") {
    return readProjectWorkflowScriptFileResult({
      scriptPath: path,
      workspaceRoot: input.workspaceRoot,
    });
  }
  return resolveWorkflowScriptFromPathOrNameResult({
    file: path,
    workspaceRoot: input.workspaceRoot,
    stateDir: input.config.stateDir,
  });
}

function runBelongsToWorkspace(
  run: Pick<WorkflowRunRecord, "workspaceId" | "workspaceRoot">,
  workspaceId: string | undefined,
  workspaceRoot: string,
): boolean {
  if (run.workspaceId) return run.workspaceId === workspaceId;
  return resolve(run.workspaceRoot) === resolve(workspaceRoot);
}

function failStartedRun(store: WorkflowStore, runId: string, error: unknown): void {
  store.failRunResult(runId, {
    error: error instanceof Error ? error.message : String(error),
    errorKind: "internal",
  });
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
