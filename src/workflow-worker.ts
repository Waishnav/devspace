import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { ServerConfig } from "./config.js";
import { parseJsonText, type JsonValue } from "./json-types.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import { createWorkflowAgentObserver } from "./workflow-agent-observer.js";
import { agentErrorFromPayload } from "./local-agent-errors.js";
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
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";
import type { LocalAgentActivity, LocalAgentUsageSnapshot } from "./local-agent-runtime.js";

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
    const availableProviders = resolveWorkflowLiveProviders(config);
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
    const agentClient = createLocalAgentClient(config);
    const workflowAgentsBySession = new Map<string, string>();

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
        const observer = createWorkflowAgentObserver(store, runId, input.callIndex);
        const scope: LocalAgentWorkspaceScope = {
          workspaceId: claimed.workspaceId,
          workspaceRoot: input.workspace,
        };
        const startedAt = new Date().toISOString();
        observer.onActivity?.({
          kind: "status",
          status: "running",
          label: `${input.provider} subagent turn`,
          startedAt,
        });
        try {
          const existingAgentId = input.providerSessionId
            ? workflowAgentsBySession.get(input.providerSessionId)
            : undefined;
          const started = existingAgentId
            ? await agentClient.continue(existingAgentId, input.prompt, {
                model: input.model,
                effort: input.effort,
                writeMode: "allowed",
              }, scope)
            : await agentClient.start({
                target: input.provider,
                prompt: input.prompt,
                workspaceRoot: input.workspace,
                workspaceId: claimed.workspaceId,
                model: input.model,
                effort: input.effort,
                writeMode: "allowed",
              });
          if (started.isErr()) throw started.error;

          const completed = await waitForWorkflowAgent({
            client: agentClient,
            initial: started.value,
            scope,
            signal: abort.signal,
            isCancelled: () => store.isCancelRequested(runId),
            onSession: (providerSessionId) => {
              workflowAgentsBySession.set(providerSessionId, started.value.id);
              observer.onSession?.(providerSessionId);
            },
            onUsage: (usage) => observer.onUsage?.(usage),
            onActivity: (activity) => observer.onActivity?.(activity),
          });
          observer.onActivity?.({
            kind: "status",
            status: "completed",
            label: `${input.provider} subagent turn`,
            startedAt,
            completedAt: new Date().toISOString(),
          });
          return {
            finalResponse: completed.latestResponse ?? "",
            providerSessionId: completed.providerSessionId,
          };
        } catch (error) {
          observer.onActivity?.({
            kind: "status",
            status: "failed",
            label: `${input.provider} subagent turn`,
            startedAt,
            completedAt: new Date().toISOString(),
          });
          throw error;
        } finally {
          observer.close();
        }
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

export function spawnWorkflowWorker(runId: string, cliEntry: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, cliEntry, "workflow", "__worker", runId],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** @deprecated Use spawnWorkflowWorker */
export const spawnWorkflowWorkerFromCli = spawnWorkflowWorker;

async function waitForWorkflowAgent(input: {
  client: LocalAgentClient;
  initial: LocalAgentRecord;
  scope: LocalAgentWorkspaceScope;
  signal: AbortSignal;
  isCancelled: () => boolean;
  onSession: (providerSessionId: string) => void;
  onUsage: (usage: LocalAgentUsageSnapshot) => void;
  onActivity: (activity: LocalAgentActivity) => void;
}): Promise<LocalAgentRecord> {
  let record = input.initial;
  let activityCursor = 0;
  let usageKey: string | undefined;
  for (;;) {
    if (activityCursor > (record.activity?.length ?? 0)) activityCursor = 0;
    for (const activity of record.activity?.slice(activityCursor) ?? []) {
      input.onActivity(activity);
    }
    activityCursor = record.activity?.length ?? 0;
    if (record.usage) {
      const nextUsageKey = JSON.stringify(record.usage);
      if (nextUsageKey !== usageKey) {
        input.onUsage(record.usage);
        usageKey = nextUsageKey;
      }
    }
    if (record.providerSessionId) input.onSession(record.providerSessionId);
    if (record.status === "idle") {
      if (record.latestResponse === undefined) {
        throw new Error(`Subagent ${record.id} completed without a response.`);
      }
      return record;
    }
    if (record.status === "error") throw agentRecordError(record);
    if (record.status === "stopped") {
      throw Object.assign(new Error(`Subagent ${record.id} was stopped.`), { name: "AbortError" });
    }
    if (input.signal.aborted || input.isCancelled()) {
      await input.client.cancel(record.id, input.scope);
      throw Object.assign(new Error("Workflow cancelled"), { name: "AbortError" });
    }
    await delay(250);
    const refreshed = await input.client.get(record.id, input.scope);
    if (refreshed.isErr()) throw refreshed.error;
    record = refreshed.value;
  }
}

function agentRecordError(record: LocalAgentRecord): Error {
  const typed = record.errorCode
    ? agentErrorFromPayload({
        code: record.errorCode,
        message: record.error ?? `Subagent ${record.id} failed.`,
        retryable: record.errorRetryable,
        provider: record.provider,
        agentId: record.id,
        operation: "workflow.agent",
      })
    : undefined;
  return typed ?? new Error(record.error ?? `Subagent ${record.id} failed.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
