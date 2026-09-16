import { open } from "node:fs/promises";
import type { Result } from "better-result";
import { loadConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import type { WorkflowCall, WorkflowRun, WorkflowRunInput } from "./workflow-types.js";
import { isManagedWorkflowWorkspace } from "./workflow-workspaces.js";

export async function runWorkflowCommand(args: string[], json: boolean): Promise<void> {
  try {
    const [command, ...rest] = args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      printWorkflowHelp();
      return;
    }
    const config = loadConfig();
    const scope = resolveCliWorkspaceContext(
      config.allowedRoots,
      process.env,
      process.cwd(),
      (root, id) => isManagedWorkflowWorkspace(config, root, id),
    );
    const client = createLocalAgentClient(config);
    switch (command) {
      case "run": {
        const input = await parseWorkflowRunArgs(rest);
        printWorkflow(unwrap(await client.runWorkflow({ ...scope, ...input })), json, true);
        return;
      }
      case "status": {
        const id = oneId(rest, "status");
        printWorkflow(unwrap(await client.getWorkflow(id, scope)), json);
        return;
      }
      case "ls":
      case "list": {
        if (rest.length > 0) usage("ls");
        const runs = unwrap(await client.listWorkflows(scope));
        if (json) printJson(runs);
        else for (const run of runs) console.log(formatWorkflow(run));
        return;
      }
      case "wait": {
        const { id, timeoutMs } = parseWorkflowWaitArgs(rest);
        printWorkflow(unwrap(await client.waitWorkflow(id, scope, timeoutMs)), json);
        return;
      }
      case "calls": {
        const id = oneId(rest, "calls");
        const calls = unwrap(await client.workflowCalls(id, scope));
        if (json) printJson(calls.map(summarizeCall));
        else for (const call of calls) console.log(formatCall(call));
        return;
      }
      case "call": {
        const [id, rawIndex, ...extra] = rest;
        if (!id || !rawIndex || extra.length > 0 || !/^\d+$/.test(rawIndex)) usage("call <id> <index>");
        const call = unwrap(await client.workflowCall(id, Number(rawIndex), scope));
        if (json) printJson(call);
        else console.log(formatCall(call, true));
        return;
      }
      case "events": {
        const { id, after } = parseWorkflowEventsArgs(rest);
        const events = unwrap(await client.workflowEvents(id, scope, after));
        if (json) printJson(events);
        else for (const event of events) {
          console.log(`<event sequence="${event.sequence}" type="${xml(event.type)}">${xml(JSON.stringify(event.data) ?? "null")}</event>`);
        }
        return;
      }
      case "cancel": {
        const id = oneId(rest, "cancel");
        printWorkflow(unwrap(await client.cancelWorkflow(id, scope)), json);
        return;
      }
      default:
        throw new Error(`Unknown workflow command: ${command}`);
    }
  } catch (error) {
    const payload = workflowErrorPayload(error);
    if (json) printJson({ error: payload });
    else console.error(`<error code="${xml(payload.code)}" retryable="${payload.retryable}">${xml(payload.message)}</error>`);
    process.exitCode = 1;
  }
}

async function parseWorkflowRunArgs(args: string[]): Promise<Omit<WorkflowRunInput, "workspaceRoot" | "workspaceId">> {
  let file: string | undefined;
  let name: string | undefined;
  let resume: string | undefined;
  let rawArgs: string | undefined;
  let argsFile: string | undefined;
  let writeMode: WorkflowRunInput["writeMode"];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    const value = args[index + 1];
    if (!value) usage("run --file <path>|--name <name>|--resume <id>");
    switch (option) {
      case "--file": file = value; break;
      case "--name": name = value; break;
      case "--resume": resume = value; break;
      case "--args": rawArgs = value; break;
      case "--args-file": argsFile = value; break;
      case "--write-mode":
        if (value !== "read_only" && value !== "allowed") throw new Error("Workflow write mode must be read_only or allowed.");
        writeMode = value;
        break;
      default: throw new Error(`Unknown option: ${option}.`);
    }
    index += 1;
  }
  if ([file, name, resume].filter(Boolean).length !== 1) {
    throw new Error("Exactly one of --file, --name, or --resume is required.");
  }
  if (rawArgs !== undefined && argsFile !== undefined) {
    throw new Error("Use only one of --args or --args-file.");
  }
  const input: Omit<WorkflowRunInput, "workspaceRoot" | "workspaceId"> = {
    ...(file ? { source: await readBoundedFile(file, 64 * 1024, "Workflow source") } : {}),
    ...(name ? { name } : {}),
    ...(resume ? { resume } : {}),
    ...(writeMode ? { writeMode } : {}),
  };
  const argsJson = rawArgs ?? (argsFile ? await readBoundedFile(argsFile, 128 * 1024, "Workflow arguments") : undefined);
  if (argsJson !== undefined) {
    if (Buffer.byteLength(argsJson) > 128 * 1024) throw new Error("Workflow arguments exceed 131072 bytes.");
    try {
      input.args = JSON.parse(argsJson) as unknown;
    } catch (cause) {
      throw new Error(`Workflow arguments are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return input;
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new Error(`${label} must be UTF-8 text.`);
    }
  } finally {
    await file.close();
  }
}

function parseWorkflowWaitArgs(args: string[]): { id: string; timeoutMs: number } {
  let id: string | undefined;
  let timeoutMs = 60_000;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--timeout") {
      const seconds = args[index + 1];
      if (!seconds || !/^\d+$/.test(seconds) || Number(seconds) > 60) {
        throw new Error("Workflow wait timeout must be an integer from 0 to 60 seconds.");
      }
      timeoutMs = Number(seconds) * 1_000;
      index += 1;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}.`);
    } else if (id) {
      usage("wait <id> [--timeout <seconds>]");
    } else {
      id = value;
    }
  }
  if (!id) usage("wait <id> [--timeout <seconds>]");
  return { id, timeoutMs };
}

function parseWorkflowEventsArgs(args: string[]): { id: string; after: number } {
  let id: string | undefined;
  let after = 0;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--after") {
      const sequence = args[index + 1];
      if (!sequence || !/^\d+$/.test(sequence) || !Number.isSafeInteger(Number(sequence))) {
        throw new Error("Workflow event sequence must be a non-negative integer.");
      }
      after = Number(sequence);
      index += 1;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}.`);
    } else if (id) {
      usage("events <id> [--after <sequence>]");
    } else {
      id = value;
    }
  }
  if (!id) usage("events <id> [--after <sequence>]");
  return { id, after };
}

function oneId(args: string[], command: string): string {
  if (args.length !== 1 || !args[0]) usage(`${command} <id>`);
  return args[0];
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

function printWorkflow(run: WorkflowRun, json: boolean, receipt = false): void {
  if (json) printJson(receipt ? { id: run.id, name: run.name, status: run.status } : run);
  else console.log(formatWorkflow(run, receipt));
}

function formatWorkflow(run: WorkflowRun, receipt = false): string {
  const attributes = [
    `id="${xml(run.id)}"`,
    `name="${xml(run.name)}"`,
    `status="${run.status}"`,
    ...(run.error ? [`code="${xml(run.error.code)}"`, `retryable="${run.error.retryable}"`] : []),
  ].join(" ");
  if (receipt) return `<workflow ${attributes}/>`;
  const detail = run.error?.message ?? (run.result === undefined ? "" : JSON.stringify(run.result));
  return detail
    ? `<workflow ${attributes} calls="${run.callCount}">${xml(detail)}</workflow>`
    : `<workflow ${attributes} calls="${run.callCount}"/>`;
}

function summarizeCall({ prompt: _prompt, result: _result, fingerprint: _fingerprint, ...call }: WorkflowCall): Omit<WorkflowCall, "prompt" | "result" | "fingerprint"> {
  return call;
}

function formatCall(call: WorkflowCall, detailed = false): string {
  const attributes = `run="${xml(call.runId)}" index="${call.index}" agent="${xml(call.agentId)}" status="${call.status}" target="${xml(call.options.target)}"`;
  if (!detailed) return `<call ${attributes}/>`;
  return `<call ${attributes}>${xml(JSON.stringify({ prompt: call.prompt, options: call.options, result: call.result, error: call.error }))}</call>`;
}

function workflowErrorPayload(error: unknown): { code: string; message: string; retryable: boolean } {
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
  return {
    code: typeof value?.code === "string" ? value.code : "WORKFLOW_COMMAND_ERROR",
    message: typeof value?.message === "string" ? value.message : String(error),
    retryable: value?.retryable === true,
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function usage(command: string): never {
  throw new Error(`Usage: devspace workflow ${command}`);
}

export function printWorkflowHelp(): void {
  console.log([
    "DevSpace workflow",
    "",
    "Usage:",
    "  devspace workflow run --file <path>|--name <name>|--resume <id> [--args <json>|--args-file <file>] [--write-mode read_only|allowed] [--json]",
    "  devspace workflow status <id> [--json]",
    "  devspace workflow wait <id> [--timeout <seconds>] [--json]",
    "  devspace workflow calls <id> [--json]",
    "  devspace workflow call <id> <index> [--json]",
    "  devspace workflow events <id> [--after <sequence>] [--json]",
    "  devspace workflow cancel <id> [--json]",
    "  devspace workflow ls [--json]",
  ].join("\n"));
}
