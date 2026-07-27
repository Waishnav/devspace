import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { ServerConfig } from "./config.js";
import { parseJsonText, type JsonValue } from "./json-types.js";
import { runLocalAgentProviderResult } from "./local-agent-adapters.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
} from "./local-agent-profiles.js";
import { executeWorkflow, mapEngineErrorKind } from "./workflow-engine.js";
import {
  readProjectWorkflowScriptFileResult,
  resolveNamedWorkflowScriptResult,
} from "./workflow-files.js";
import { createWorkflowReplay } from "./workflow-replay.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { createWorkflowStore } from "./workflow-store.js";
import {
  WORKFLOW_HEARTBEAT_MS,
  WORKFLOW_LIMITS,
  resolveWorkflowConcurrency,
} from "./workflow-types.js";
import { WorkflowStoredDataError } from "./workflow-errors.js";
import { createWorkflowWorktreeFactory } from "./workflow-worktrees.js";
import { resolveWorkflowLiveProviders } from "./workflow-providers.js";

/** Detached worker entry: claim run, heartbeat, execute, complete/fail. */
export async function runWorkflowWorker(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Usage: devspace workflow __worker <runId>");

  const store = createWorkflowStore(config);
  const claim = store.claimRunResult(runId, process.pid);
  if (claim.isErr()) {
    store.close();
    throw claim.error;
  }
  const claimed = claim.value;

  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      store.setHeartbeat(runId);
      if (store.isCancelRequested(runId)) abort.abort();
    } catch {
      // store closed
    }
  }, WORKFLOW_HEARTBEAT_MS);

  try {
    const source = await readFile(claimed.scriptPath, "utf8");
    const parsed = parseWorkflowScript(source, { filename: claimed.scriptPath });
    const availableProviders = resolveWorkflowLiveProviders();
    const agentProfiles = await loadLocalAgentProfiles(config, claimed.workspaceRoot);
    const concurrency = resolveWorkflowConcurrency(
      parsed.meta.concurrency,
      availableParallelism(),
    );

    let argsValue: JsonValue | undefined;
    try {
      argsValue = parseJsonText(claimed.argsJson);
      if (argsValue === null) argsValue = undefined;
    } catch (cause) {
      throw new WorkflowStoredDataError(`${claimed.id}.argsJson`, cause);
    }

    const replay = claimed.resumedFromRunId
      ? createWorkflowReplay(store.listAgentCalls(claimed.resumedFromRunId))
      : undefined;

    const createWorktree = createWorkflowWorktreeFactory({
      worktreeRoot: config.worktreeRoot,
      allowedRoots: config.allowedRoots,
    });

    const { result, callCount } = await executeWorkflow({
      parsed,
      runId,
      journal: store,
      args: argsValue,
      concurrency,
      signal: abort.signal,
      workspaceRoot: claimed.workspaceRoot,
      baseSha: claimed.baseSha,
      availableProviders,
      agentProfiles,
      createWorktree,
      replay,
      runProvider: async (input) => {
        if (!isLocalAgentProvider(input.provider)) {
          throw new Error(`Unknown provider: ${input.provider}`);
        }
        if (abort.signal.aborted || store.isCancelRequested(runId)) {
          throw Object.assign(new Error("Workflow cancelled"), { name: "AbortError" });
        }
        const providerRun = await runLocalAgentProviderResult(input.provider, {
          prompt: input.prompt,
          workspace: input.workspace,
          providerSessionId: input.providerSessionId,
          model: input.model,
          effort: input.effort,
          writeMode: "allowed",
          schema: input.schema,
        });
        if (providerRun.isErr()) throw providerRun.error;
        const providerResult = providerRun.value;
        return {
          finalResponse: providerResult.finalResponse,
          providerSessionId: providerResult.providerSessionId ?? undefined,
          structured: providerResult.structured,
        };
      },
      resolveNestedSource: async (ref) => {
        if (typeof ref === "string") {
          const named = await resolveNamedWorkflowScriptResult({
            name: ref,
            workspaceRoot: claimed.workspaceRoot,
            stateDir: config.stateDir,
          });
          if (named.isErr()) throw named.error;
          return named.value.source;
        }
        const nested = await readProjectWorkflowScriptFileResult({
          scriptPath: ref.scriptPath,
          workspaceRoot: claimed.workspaceRoot,
        });
        if (nested.isErr()) throw nested.error;
        return nested.value.source;
      },
    });

    if (abort.signal.aborted || store.isCancelRequested(runId)) {
      store.cancelRun(runId);
      return;
    }

    let resultJson: string | undefined;
    if (result !== undefined) {
      resultJson = JSON.stringify(result);
      if (Buffer.byteLength(resultJson, "utf8") > WORKFLOW_LIMITS.resultJsonBytes) {
        store.failRun(runId, {
          error: `result exceeds ${WORKFLOW_LIMITS.resultJsonBytes} bytes`,
          errorKind: "result_too_large",
        });
        return;
      }
    }

    store.completeRun(runId, { resultJson, callCount });
  } catch (error) {
    if (store.isCancelRequested(runId) || abort.signal.aborted) {
      try {
        store.cancelRun(runId);
      } catch {
        // already terminal
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorKind = mapEngineErrorKind(error);
    try {
      store.failRun(runId, { error: message, errorKind });
    } catch {
      // terminal race
    }
  } finally {
    clearInterval(heartbeat);
    store.close();
  }
}

export function spawnWorkflowWorker(runId: string, cliEntry: string): void {
  const child = spawn(
    process.execPath,
    [...process.execArgv, cliEntry, "workflow", "__worker", runId],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
}

/** @deprecated Use spawnWorkflowWorker */
export const spawnWorkflowWorkerFromCli = spawnWorkflowWorker;
