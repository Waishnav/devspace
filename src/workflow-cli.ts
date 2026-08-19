import { fileURLToPath } from "node:url";
import {
  assertRecordInCliWorkspace,
  resolveCliWorkspaceContext,
  type CliWorkspaceContext,
} from "./cli-workspace.js";
import { workflowCallOutput, workflowRunOutput } from "./cli-output.js";
import type { ServerConfig } from "./config.js";
import { parseWorkflowArgFlagsResult } from "./workflow-files.js";
import {
  cancelWorkflowRun,
  reapStaleWorkflows,
} from "./workflow-lifecycle.js";
import { createWorkflowStore, type WorkflowStore } from "./workflow-store.js";
import {
  WORKFLOW_LIMITS,
  type WorkflowEventRecord,
  type WorkflowAgentCallRecord,
  type WorkflowRunRecord,
} from "./workflow-types.js";
import { parseWorkflowEventPayload } from "./workflow-contracts.js";
import {
  InvalidWorkflowInputError,
  WorkflowNotFoundError,
} from "./workflow-errors.js";
import {
  launchWorkflowRun,
  type LaunchWorkflowSource,
} from "./workflow-launch.js";
import {
  runWorkflowWorker,
  spawnWorkflowWorker,
  spawnWorkflowWorkerFromCli,
} from "./workflow-worker.js";
import { resolveCliEntry } from "./workflow-cli-entry.js";

export { runWorkflowWorker, spawnWorkflowWorker, spawnWorkflowWorkerFromCli };

export async function runWorkflowCommand(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!config.workflows) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message:
        "Dynamic Workflows are disabled. Run `devspace init --force` or set DEVSPACE_WORKFLOWS=1.",
    });
  }
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
      await runWorkflowList(rest, config);
      return;
    case "calls":
      await runWorkflowCalls(rest, config);
      return;
    case "call":
      await runWorkflowCall(rest, config);
      return;
    case "tui": {
      const { runWorkflowTui } = await import("./workflow-tui.js");
      await runWorkflowTui(rest, config);
      return;
    }
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
      throw new InvalidWorkflowInputError({
        code: "invalid_argument",
        message: `Unknown workflow command: ${subcommand}`,
      });
  }
}

export function printWorkflowHelp(): void {
  console.log(
    [
      "DevSpace workflows",
      "",
      "Usage:",
      "  devspace workflow run [--file|--script-path <path> | --name <name>] [--resume <runId>]",
      "                        [--arg key=value]... [--follow] [--json]",
      "  devspace workflow status <runId> [--follow] [--json]",
      "  devspace workflow cancel <runId> [--json]",
      "  devspace workflow ls [--json]",
      "  devspace workflow calls <runId> [--json]",
      "  devspace workflow call <runId> <callIndex> [--json]",
      "  devspace workflow tui [runId]  # current working directory",
    ].join("\n"),
  );
}

async function runWorkflowRun(args: string[], config: ServerConfig): Promise<void> {
  const { flags } = splitFlags(args);
  const follow = flags.has("follow");
  const json = flags.has("json");
  if (follow && json) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Use either --follow or --json, then poll workflow status.",
    });
  }
  const file = flagValue(flags, "script-path") ?? flagValue(flags, "file");
  const name = flagValue(flags, "name");
  const resumeFrom = flagValue(flags, "resume");
  const parsedArgs = parseWorkflowArgFlagsResult(collectArgTokens(args));
  if (parsedArgs.isErr()) throw parsedArgs.error;
  const workflowArgs = parsedArgs.value.args;

  if (file && name) {
    throw new InvalidWorkflowInputError({
      code: "ambiguous_source",
      message: "Provide only one of --file/--script-path or --name",
    });
  }
  if (!file && !name && !resumeFrom) {
    throw new InvalidWorkflowInputError({
      code: "missing_source",
      message:
        "Usage: devspace workflow run [--file|--script-path <path> | --name <name>] [--resume <runId>]",
    });
  }

  const source = buildCliLaunchSource({ file, name, resumeFrom });
  const store = createWorkflowStore(config);
  try {
    const workspace = resolveCliWorkspaceContext();
    const workspaceRoot = workspace.workspaceRoot;
    if (resumeFrom) {
      const prior = store.getRun(resumeFrom);
      if (!prior) throw new WorkflowNotFoundError(resumeFrom);
      assertWorkflowInCurrentProject(prior, workspace);
    }
    // Undefined args on resume make launch reload the prior run's args.
    const argsValue = Object.keys(workflowArgs).length ? workflowArgs : undefined;

    const launched = await launchWorkflowRun({
      store,
      config,
      workspaceRoot,
      workspaceId: workspace.workspaceId,
      source,
      args: argsValue,
      scriptFileScope: "local",
      cliEntry: resolveCliEntry(),
    });
    if (launched.isErr()) throw launched.error;

    if (json) printJson({ workflow: workflowRunOutput(launched.value.run) });
    else console.log(formatRunLine(launched.value.run));

    if (follow) {
      await followRun(store, launched.value.run.id);
    }
  } finally {
    store.close();
  }
}

function buildCliLaunchSource(input: {
  file?: string;
  name?: string;
  resumeFrom?: string;
}): LaunchWorkflowSource {
  if (input.resumeFrom) {
    const override = input.file
      ? ({ kind: "file", path: input.file } as const)
      : input.name
        ? ({ kind: "named", name: input.name } as const)
        : undefined;
    return { kind: "resume", runId: input.resumeFrom, override };
  }
  if (input.file) return { kind: "file", path: input.file };
  if (input.name) return { kind: "named", name: input.name };
  throw new InvalidWorkflowInputError({
    code: "missing_source",
    message: "Provide --file/--script-path, --name, or --resume",
  });
}

async function runWorkflowStatus(args: string[], config: ServerConfig): Promise<void> {
  const follow = args.includes("--follow");
  const json = args.includes("--json");
  if (follow && json) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Use either --follow or --json, then poll workflow status.",
    });
  }
  const runId = args.find((a) => !a.startsWith("-"));
  if (!runId) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow status <runId> [--follow]",
    });
  }

  const store = createWorkflowStore(config);
  try {
    reapStaleWorkflows(store);
    const workspace = resolveCliWorkspaceContext();
    const runResult = store.getRunResult(runId);
    if (runResult.isErr()) throw runResult.error;
    const run = runResult.value;
    if (!run) throw new WorkflowNotFoundError(runId);
    assertWorkflowInCurrentProject(run, workspace);
    const calls = store.listAgentCalls(runId);
    if (json) {
      printJson({ workflow: workflowRunOutput(run, calls) });
      return;
    }
    console.log(formatRunLine(run));
    console.log(formatCallSummary(calls));
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
  const json = args.includes("--json");
  const [runId, ...unknownArgs] = args.filter((arg) => arg !== "--json");
  if (!runId) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow cancel <runId>",
    });
  }
  if (unknownArgs.length > 0) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow cancel <runId> [--json]",
    });
  }
  const store = createWorkflowStore(config);
  try {
    reapStaleWorkflows(store);
    const run = store.getRun(runId);
    if (!run) throw new WorkflowNotFoundError(runId);
    assertWorkflowInCurrentProject(run, resolveCliWorkspaceContext());
    const cancelled = await cancelWorkflowRun(store, runId);
    if (json) printJson({ workflow: workflowRunOutput(cancelled) });
    else console.log(formatRunLine(cancelled));
  } finally {
    store.close();
  }
}

async function runWorkflowList(args: string[], config: ServerConfig): Promise<void> {
  const json = parseJsonOnlyOption(args, "devspace workflow ls [--json]");
  const store = createWorkflowStore(config);
  try {
    reapStaleWorkflows(store);
    const runs = store.listRunsForScope(resolveCliWorkspaceContext(), {
      limit: 50,
    });
    if (json) {
      printJson({ workflows: runs.map((run) => workflowRunOutput(run)) });
      return;
    }
    if (runs.length === 0) {
      console.log("No workflow runs.");
      return;
    }
    for (const run of runs) console.log(formatRunLine(run));
  } finally {
    store.close();
  }
}

async function runWorkflowCalls(args: string[], config: ServerConfig): Promise<void> {
  const json = args.includes("--json");
  const [runId, ...unknownArgs] = args.filter((arg) => arg !== "--json");
  if (!runId) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow calls <runId>",
    });
  }
  if (unknownArgs.length > 0) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow calls <runId> [--json]",
    });
  }
  const store = createWorkflowStore(config);
  try {
    const run = store.getRun(runId);
    if (!run) throw new WorkflowNotFoundError(runId);
    assertWorkflowInCurrentProject(run, resolveCliWorkspaceContext());
    const calls = store.listAgentCalls(runId);
    if (json) {
      printJson({
        workflowId: runId,
        calls: calls.map((call) => workflowCallOutput(call)),
      });
      return;
    }
    if (calls.length === 0) {
      console.log("No workflow agent calls.");
      return;
    }
    for (const call of calls) console.log(formatCallLine(call));
  } finally {
    store.close();
  }
}

async function runWorkflowCall(args: string[], config: ServerConfig): Promise<void> {
  const json = args.includes("--json");
  const [runId, callIndexValue, ...unknownArgs] = args.filter((arg) => arg !== "--json");
  const callIndex = Number(callIndexValue);
  if (!runId || !Number.isInteger(callIndex) || callIndex < 0) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow call <runId> <callIndex>",
    });
  }
  if (unknownArgs.length > 0) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: "Usage: devspace workflow call <runId> <callIndex> [--json]",
    });
  }
  const store = createWorkflowStore(config);
  try {
    const run = store.getRun(runId);
    if (!run) throw new WorkflowNotFoundError(runId);
    assertWorkflowInCurrentProject(run, resolveCliWorkspaceContext());
    const call = store.getAgentCall(runId, callIndex);
    if (!call) {
      throw new InvalidWorkflowInputError({
        code: "invalid_argument",
        message: `Unknown workflow agent call: ${runId}#${callIndex}`,
      });
    }
    if (json) printJson({ call: workflowCallOutput(call, { detailed: true }) });
    else console.log(JSON.stringify(formatCallDetail(call), null, 2));
  } finally {
    store.close();
  }
}

function assertWorkflowInCurrentProject(
  run: WorkflowRunRecord,
  workspace: CliWorkspaceContext,
): void {
  assertRecordInCliWorkspace(run, workspace, "Workflow run");
}

function parseJsonOnlyOption(args: string[], usage: string): boolean {
  if (args.some((arg) => arg !== "--json")) {
    throw new InvalidWorkflowInputError({
      code: "invalid_argument",
      message: `Usage: ${usage}`,
    });
  }
  return args.includes("--json");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
        message = parseWorkflowEventPayload(
          "log",
          JSON.parse(event.dataJson) as unknown,
        ).message;
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
  run: Pick<
    WorkflowRunRecord,
    "id" | "status" | "name" | "error" | "scriptPath" | "scriptHash" | "resumedFromRunId"
  >,
): string {
  const err = run.error ? ` error=${JSON.stringify(run.error)}` : "";
  const resumed = run.resumedFromRunId ? ` resumedFrom=${run.resumedFromRunId}` : "";
  return `${run.id} ${run.status} ${run.name} scriptPath=${JSON.stringify(run.scriptPath)} scriptHash=${run.scriptHash}${resumed}${err}`;
}

function formatCallLine(call: WorkflowAgentCallRecord): string {
  const label = call.label ? ` label=${JSON.stringify(call.label)}` : "";
  const phase = call.phase ? ` phase=${JSON.stringify(call.phase)}` : "";
  const model = call.model ? ` model=${call.model}` : "";
  const duration = callDurationMs(call);
  const replay = call.fromCache
    ? ` replay=${call.replayMatch ?? "cached"}:${call.replayedFromRunId ?? "?"}#${call.replayedFromCallIndex ?? "?"}`
    : call.replayReason
      ? ` replayMiss=${call.replayReason}`
      : "";
  const worktree = call.worktreePath
    ? ` worktree=${JSON.stringify(call.worktreePath)} dirty=${String(call.dirty)}`
    : "";
  return `#${call.callIndex} ${call.status} ${call.provider}${model}${label}${phase} durationMs=${duration}${replay}${worktree}`;
}

function formatCallSummary(calls: WorkflowAgentCallRecord[]): string {
  const reused = calls.filter((call) => call.fromCache).length;
  const failed = calls.filter((call) => call.status === "failed").length;
  const live = calls.filter(
    (call) => !call.fromCache && call.status === "completed",
  ).length;
  const running = calls.filter((call) => call.status === "running").length;
  return `calls reused=${reused} live=${live} failed=${failed} running=${running} total=${calls.length}`;
}

function formatCallDetail(call: WorkflowAgentCallRecord): Record<string, unknown> {
  return {
    ...call,
    durationMs: callDurationMs(call),
    schema: call.schemaJson ? safeParseJson(call.schemaJson) : undefined,
    structured: call.structuredJson ? safeParseJson(call.structuredJson) : undefined,
  };
}

function callDurationMs(call: WorkflowAgentCallRecord): number | undefined {
  if (!call.startedAt || !call.completedAt) return undefined;
  return Math.max(0, Date.parse(call.completedAt) - Date.parse(call.startedAt));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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
      if (next && !next.startsWith("-") && key !== "follow" && key !== "json") {
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
