import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { decodeWorkflowRequest, type WorkflowOperation } from "./workflow-protocol.js";

export const WORKFLOW_CLI_HELP = [
  "devspace workflows run <script.js> [--args-file input.json] [--agent <profile-or-provider>]",
  "devspace workflows run --name <saved-name> [--args-file input.json]",
  "devspace workflows run <script.js> --resume-from <run-id>",
  "devspace workflows show <run-id> [--step <step-id>] [--after-revision <revision>]",
  "devspace workflows wait <run-id> [--timeout <seconds>] [--after-revision <revision>]",
  "devspace workflows <pause|resume|stop> <run-id>",
  "devspace workflows <stop-agent|restart-agent> <run-id> --step <step-id>",
  "devspace workflows ls [--definitions] [--cursor <cursor>] [--limit <count>]",
  "devspace workflows save <run-id> --name <name> [--location project|user] [--replace]",
  "Run options: --model <model> --effort <effort> --budget <output-tokens>",
  "All commands accept --json. Script path '-' reads source from stdin.",
].join("\n");

export function parseWorkflowCli(args: string[]): { operation: WorkflowOperation; input: Record<string, unknown>; json: boolean } {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    json: { type: "boolean" }, name: { type: "string" }, "args-file": { type: "string" },
    agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    budget: { type: "string" }, "resume-from": { type: "string" }, step: { type: "string" },
    timeout: { type: "string" }, "after-revision": { type: "string" },
    cursor: { type: "string" }, limit: { type: "string" },
    definitions: { type: "boolean" }, location: { type: "string" }, replace: { type: "boolean" },
  } });
  const [command, target, ...extra] = positionals;
  if (extra.length) throw new Error("Unexpected workflow arguments.\n" + WORKFLOW_CLI_HELP);
  const flags: Record<string, string[]> = {
    run: ["name", "args-file", "agent", "model", "effort", "budget", "resume-from"],
    show: ["step", "after-revision"], wait: ["timeout", "after-revision"], pause: [], resume: [], stop: [],
    "stop-agent": ["step"], "restart-agent": ["step"], ls: ["definitions", "cursor", "limit"],
    save: ["name", "location", "replace"],
  };
  for (const key of Object.keys(values)) {
    if (key !== "json" && !flags[command ?? ""]?.includes(key)) {
      throw new Error(`--${key} is not valid for workflows ${command ?? ""}.`);
    }
  }
  const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
  let operation: WorkflowOperation;
  let input: Record<string, unknown>;
  switch (command) {
    case "run":
      operation = "run";
      input = { scriptPath: target, name: values.name, agentType: values.agent, model: values.model,
        effort: values.effort, outputTokenBudget: number(values.budget), resumeFromRunId: values["resume-from"] };
      break;
    case "show":
      operation = "get"; input = { runId: target, stepId: values.step, afterRevision: number(values["after-revision"]) }; break;
    case "wait":
      operation = "wait"; input = { runId: target, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) * 1000,
        afterRevision: number(values["after-revision"]) }; break;
    case "pause": case "resume": case "stop": case "stop-agent": case "restart-agent":
      operation = "control"; input = { runId: target, action: command.replaceAll("-", "_"), stepId: values.step }; break;
    case "ls":
      if (target) throw new Error("workflows ls does not accept a run ID.");
      operation = "list"; input = { kind: values.definitions ? "definitions" : "runs", cursor: values.cursor, limit: number(values.limit) }; break;
    case "save":
      operation = "save"; input = { runId: target, name: values.name, location: values.location ?? "project", replace: values.replace }; break;
    default: throw new Error(WORKFLOW_CLI_HELP);
  }
  if (values["args-file"] !== undefined) {
    if (operation !== "run") throw new Error("--args-file is only valid for workflows run.");
    input.argsFile = values["args-file"];
  }
  return { operation, input: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), json: values.json ?? false };
}

export async function runWorkflowsCommand(args: string[]): Promise<void> {
  try { await executeWorkflowsCommand(args); }
  catch (error) {
    if (!args.includes("--json")) throw error;
    console.error(JSON.stringify({ error: {
      code: "WORKFLOW_COMMAND_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false,
    } }));
    process.exitCode = 1;
  }
}

async function executeWorkflowsCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    console.log(WORKFLOW_CLI_HELP);
    return;
  }
  const parsed = parseWorkflowCli(args);
  if (process.env.DEVSPACE_WORKFLOW_RUN_ID && (parsed.operation === "run" || parsed.operation === "control")) {
    throw new Error("Workflow workers cannot launch or control workflows through the CLI. Return the task to the owning workflow.");
  }
  const input = parsed.input;
  if (input.argsFile !== undefined) {
    const path = String(input.argsFile);
    if (path === "-" && input.scriptPath === "-") throw new Error("Script and arguments cannot both read stdin.");
    input.args = JSON.parse(path === "-" ? await readStdin() : await readFile(path, "utf8"));
    delete input.argsFile;
  }
  if (input.scriptPath === "-") { input.script = await readStdin(); delete input.scriptPath; }
  const config = loadConfig();
  const current = resolveCliWorkspaceContext(config.allowedRoots);
  const store = new SqliteWorkspaceStore(config.stateDir);
  try {
    const registry = new WorkspaceRegistry(config, store);
    const workspace = current.workspaceId
      ? await registry.getWorkspace(current.workspaceId)
      : (await registry.openWorkspace({ path: current.workspaceRoot }, {
          conversationScopeId: `local-workflow-cli:${current.workspaceRoot}`,
        })).workspace;
    const request = decodeWorkflowRequest({ operation: parsed.operation, input,
      scope: { workspaceId: workspace.id, workspaceRoot: workspace.root } });
    const result = await createLocalAgentClient(config).workflow(request);
    if (!result.ok) {
      console.error(JSON.stringify(result.error, null, parsed.json ? undefined : 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result.result, null, parsed.json ? undefined : 2));
  } finally { store.close(); }
}

async function readStdin(): Promise<string> {
  let result = "";
  for await (const chunk of process.stdin) {
    result += chunk.toString();
    if (Buffer.byteLength(result) > 1024 * 1024) throw new Error("Workflow stdin exceeds 1 MiB.");
  }
  return result;
}
