import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
} from "./local-agent-profiles.js";
import { executeWorkflow, mapEngineErrorKind } from "./workflow-engine.js";
import {
  parseWorkflowArgFlags,
  persistWorkflowScript,
  readWorkflowScriptFile,
  resolveNamedWorkflowScript,
  resolveWorkflowScriptFromPathOrName,
} from "./workflow-files.js";
import { createWorkflowReplay } from "./workflow-replay.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { createWorkflowStore, type WorkflowStore } from "./workflow-store.js";
import {
  WORKFLOW_CANCEL_HARD_MS,
  WORKFLOW_HEARTBEAT_MS,
  WORKFLOW_LIMITS,
  resolveWorkflowConcurrency,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
  type WorkflowRunSource,
} from "./workflow-types.js";
import {
  createWorkflowWorktreeFactory,
  resolveWorkspaceHead,
} from "./workflow-worktrees.js";

export async function runWorkflowCommand(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "run":
      await runWorkflowRun(rest, config);
      return;
    case "status":
      await runWorkflowStatus(rest, config);
      return;
    case "cancel":
      await runWorkflowCancel(rest, config);
      return;
    case "ls":
    case "list":
      await runWorkflowList(config);
      return;
    case "__worker":
      await runWorkflowWorker(rest, config);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printWorkflowHelp();
      return;
    default:
      throw new Error(`Unknown workflow command: ${subcommand}`);
  }
}

export function printWorkflowHelp(): void {
  console.log(
    [
      "DevSpace workflows",
      "",
      "Usage:",
      "  devspace workflow run (--file <path> | --name <name> | --resume <runId>)",
      "                        [--arg key=value]... [--follow]",
      "  devspace workflow status <runId> [--follow]",
      "  devspace workflow cancel <runId>",
      "  devspace workflow ls",
    ].join("\n"),
  );
}

async function runWorkflowRun(args: string[], config: ServerConfig): Promise<void> {
  const { flags } = splitFlags(args);
  const follow = flags.has("follow");
  const file = flagValue(flags, "file");
  const name = flagValue(flags, "name");
  const resumeFrom = flagValue(flags, "resume");
  const { args: workflowArgs } = parseWorkflowArgFlags(collectArgTokens(args));

  if (!file && !name && !resumeFrom) {
    throw new Error(
      "Usage: devspace workflow run (--file <path> | --name <name> | --resume <runId>)",
    );
  }

  const store = createWorkflowStore(config);
  try {
    const workspaceRoot = resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
    let source: string;
    let scriptHash: string;
    let nameHint: string;
    let runSource: WorkflowRunSource = "inline";
    let priorRunId: string | undefined;
    let priorScriptPath: string | undefined;

    if (resumeFrom) {
      const prior = store.getRun(resumeFrom);
      if (!prior) throw new Error(`Unknown workflow run to resume: ${resumeFrom}`);
      priorRunId = prior.id;
      priorScriptPath = prior.scriptPath;
      const resolved = await readWorkflowScriptFile(prior.scriptPath);
      source = resolved.source;
      scriptHash = prior.scriptHash;
      nameHint = prior.name;
      runSource = "resume";
      if (!Object.keys(workflowArgs).length && prior.argsJson && prior.argsJson !== "null") {
        try {
          Object.assign(workflowArgs, JSON.parse(prior.argsJson) as object);
        } catch {
          // keep empty
        }
      }
    } else {
      const resolved = await resolveWorkflowScriptFromPathOrName({
        file,
        name,
        workspaceRoot,
        stateDir: config.stateDir,
      });
      source = resolved.source;
      scriptHash = resolved.scriptHash;
      nameHint = resolved.nameHint;
      runSource = resolved.origin === "named" ? "named" : "inline";
    }

    const parsed = parseWorkflowScript(source, {
      filename: priorScriptPath ?? file ?? name ?? "workflow:inline",
    });
    const baseSha = await resolveWorkspaceHead(workspaceRoot);

    const run = store.createRun({
      name: parsed.meta.name || nameHint,
      source: runSource,
      scriptPath: priorScriptPath ?? "pending",
      scriptHash,
      workspaceRoot,
      workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
      argsJson: JSON.stringify(Object.keys(workflowArgs).length ? workflowArgs : null),
      resumedFromRunId: priorRunId,
      baseSha,
    });

    const persisted =
      priorScriptPath ??
      (await persistWorkflowScript({
        stateDir: config.stateDir,
        runId: run.id,
        source,
        preferredName: parsed.meta.name || nameHint,
      }));
    if (!priorScriptPath) {
      store.setScriptPath(run.id, persisted);
    }

    spawnWorkflowWorkerFromCli(
      run.id,
      fileURLToPath(import.meta.url.replace(/workflow-cli\.(ts|js)$/, "cli.$1")),
    );

    console.log(formatRunLine(store.getRun(run.id) ?? { ...run, scriptPath: persisted }));

    if (follow) {
      await followRun(store, run.id);
    }
  } finally {
    store.close();
  }
}

async function runWorkflowStatus(args: string[], config: ServerConfig): Promise<void> {
  const follow = args.includes("--follow");
  const runId = args.find((a) => !a.startsWith("-"));
  if (!runId) throw new Error("Usage: devspace workflow status <runId> [--follow]");

  const store = createWorkflowStore(config);
  try {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Unknown workflow run: ${runId}`);
    console.log(formatRunLine(run));
    if (follow) {
      await followRun(store, runId);
      return;
    }
    if (run.resultJson) console.log(run.resultJson);
    else if (run.error) console.log(run.error);
  } finally {
    store.close();
  }
}

async function runWorkflowCancel(args: string[], config: ServerConfig): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Usage: devspace workflow cancel <runId>");
  const store = createWorkflowStore(config);
  try {
    const run = store.requestCancel(runId);
    console.log(formatRunLine(run));
    if (run.pid && (run.status === "running" || run.status === "starting")) {
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // already dead
      }
      await sleep(WORKFLOW_CANCEL_HARD_MS);
      const again = store.getRun(runId);
      if (again && (again.status === "running" || again.status === "starting") && again.pid) {
        try {
          process.kill(-again.pid, "SIGKILL");
        } catch {
          try {
            process.kill(again.pid, "SIGKILL");
          } catch {
            // gone
          }
        }
        const latest = store.getRun(runId);
        if (latest && (latest.status === "running" || latest.status === "starting")) {
          store.cancelRun(runId, "cancelled (hard kill)");
        }
      }
    }
    console.log(formatRunLine(store.getRun(runId)!));
  } finally {
    store.close();
  }
}

async function runWorkflowList(config: ServerConfig): Promise<void> {
  const store = createWorkflowStore(config);
  try {
    const runs = store.listRuns(50);
    if (runs.length === 0) {
      console.log("No workflow runs.");
      return;
    }
    for (const run of runs) console.log(formatRunLine(run));
  } finally {
    store.close();
  }
}

/** Detached worker entry: claim run, heartbeat, execute, complete/fail. */
export async function runWorkflowWorker(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Usage: devspace workflow __worker <runId>");

  const store = createWorkflowStore(config);
  const claimed = store.claimRun(runId, process.pid);
  if (!claimed) {
    store.close();
    throw new Error(`Cannot claim workflow run ${runId} (missing or not starting)`);
  }

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
    const enabledProviders = resolveEnabledProviders(config.agentProviders);
    const concurrency = resolveWorkflowConcurrency(
      parsed.meta.concurrency,
      availableParallelism(),
    );

    let argsValue: unknown;
    try {
      argsValue = JSON.parse(claimed.argsJson);
      if (argsValue === null) argsValue = undefined;
    } catch {
      argsValue = undefined;
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
      enabledProviders,
      createWorktree,
      replay,
      runProvider: async (input) => {
        if (!isLocalAgentProvider(input.provider)) {
          throw new Error(`Unknown provider: ${input.provider}`);
        }
        if (abort.signal.aborted || store.isCancelRequested(runId)) {
          throw Object.assign(new Error("Workflow cancelled"), { name: "AbortError" });
        }
        const providerResult = await runLocalAgentProvider(input.provider, {
          prompt: input.prompt,
          workspace: input.workspace,
          providerSessionId: input.providerSessionId,
          model: input.model,
          effort: input.effort,
          writeMode: "allowed",
          schema: input.schema,
        });
        return {
          finalResponse: providerResult.finalResponse,
          providerSessionId: providerResult.providerSessionId ?? undefined,
          structured: providerResult.structured,
        };
      },
      resolveNestedSource: async (ref) => {
        if (typeof ref === "string") {
          const named = await resolveNamedWorkflowScript({
            name: ref,
            workspaceRoot: claimed.workspaceRoot,
            stateDir: config.stateDir,
          });
          return named.source;
        }
        return readFile(ref.scriptPath, "utf8");
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

    store.completeRun(runId, { resultJson });
    store.appendEvent({
      runId,
      type: "run_completed",
      data: { callCount },
    });
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
      store.appendEvent({
        runId,
        type: "run_failed",
        data: { error: message, errorKind },
      });
    } catch {
      // terminal race
    }
  } finally {
    clearInterval(heartbeat);
    store.close();
  }
}

export function spawnWorkflowWorkerFromCli(runId: string, cliEntry: string): void {
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

async function followRun(store: WorkflowStore, runId: string): Promise<void> {
  let sinceSeq = 0;
  for (;;) {
    const page = store.drainEvents(runId, sinceSeq, WORKFLOW_LIMITS.eventDrainDefault);
    for (const event of page.events) printEvent(event);
    sinceSeq = page.nextSeq;
    if (page.terminal) {
      const run = page.run;
      if (run.resultJson) console.log(run.resultJson);
      else if (run.error) console.log(run.error);
      return;
    }
    await sleep(300);
  }
}

function printEvent(event: WorkflowEventRecord): void {
  const prefix = event.phase ? `[${event.phase}] ` : "";
  switch (event.type) {
    case "log": {
      let message = event.dataJson;
      try {
        message = String(
          (JSON.parse(event.dataJson) as { message?: string }).message ?? event.dataJson,
        );
      } catch {
        // raw
      }
      console.log(`${prefix}${message}`);
      break;
    }
    case "phase_started":
      console.log(`== phase ${event.phase ?? ""} ==`);
      break;
    case "agent_call_started":
      console.log(`${prefix}agent start ${event.label ?? ""}`.trim());
      break;
    case "agent_call_completed":
      console.log(`${prefix}agent done ${event.label ?? ""}`.trim());
      break;
    case "agent_call_cached":
      console.log(`${prefix}agent cache ${event.label ?? ""}`.trim());
      break;
    case "agent_call_failed":
      console.log(`${prefix}agent fail ${event.label ?? ""} ${event.dataJson}`.trim());
      break;
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
      console.log(event.type);
      break;
    default:
      break;
  }
}

function formatRunLine(
  run: Pick<WorkflowRunRecord, "id" | "status" | "name" | "error">,
): string {
  const err = run.error ? ` error=${JSON.stringify(run.error)}` : "";
  return `${run.id} ${run.status} ${run.name}${err}`;
}

function resolveEnabledProviders(
  agentProviders?: ServerConfig["agentProviders"],
): string[] {
  const snapshot = getLocalAgentProviderAvailabilitySnapshot();
  const live = new Set(snapshot.filter((row) => row.available).map((row) => row.name));
  if (!agentProviders) {
    return LOCAL_AGENT_PROVIDERS.filter((id) => live.has(id));
  }
  return agentProviders.enabled.filter((id) => live.has(id as never));
}

function splitFlags(args: string[]): {
  flags: Map<string, string | true>;
  positionals: string[];
} {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-") && key !== "follow") {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function flagValue(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function collectArgTokens(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--arg") {
      out.push(token, args[++i] ?? "");
      continue;
    }
    if (token.startsWith("--arg=")) out.push(token);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
