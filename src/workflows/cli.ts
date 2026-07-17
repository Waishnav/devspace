import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import { devspaceAgentsDir, loadDevspaceFiles, resolveSubagentsFlag } from "../user-config.js";
import { loadLocalAgentProfiles } from "../local-agent-profiles.js";
import { expandHomePath } from "../roots.js";
import { createWorkflowSubmission } from "./submission.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import { executeWorkflowRuntime } from "./runtime.js";
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from "./store.js";
import { ensureSupervisor } from "./supervisor-launch.js";
import { runWorkflowSupervisor } from "./supervisor.js";
import type {
  JsonObject,
  WorkflowRunRecord,
  WorkflowWorkspaceScope,
} from "./types.js";

const ENVELOPE_VERSION = 1 as const;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;

export interface WorkflowsCliContext {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
  cliEntrypoint: string;
}

interface WorkflowCliConfig {
  stateDir: string;
  worktreeRoot: string;
  allowedRoots: string[];
  devspaceAgentsDir: string;
  subagents: boolean;
}

export async function runWorkflowsCli(context: WorkflowsCliContext): Promise<number> {
  const [command, ...args] = context.argv;
  if (command === "__supervisor") {
    validateWorkflowArguments(command, args);
    const stateDir = requiredOption(args, "--state-dir");
    await runWorkflowSupervisor(stateDir);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    context.stdout.write(workflowsHelp());
    return 0;
  }

  const jsonMode = args.includes("--json");
  try {
    const result = await dispatchWorkflowCommand(command, args, context);
    writeEnvelope(context.stdout, { ok: true, command, ...result });
    return 0;
  } catch (error) {
    const normalized = normalizeCliError(error);
    if (jsonMode) {
      writeEnvelope(context.stdout, { ok: false, command, error: normalized });
    } else {
      context.stderr.write(`${normalized.message}\n`);
    }
    return normalized.exitCode;
  }
}

async function dispatchWorkflowCommand(
  command: string,
  args: string[],
  context: WorkflowsCliContext,
): Promise<Record<string, unknown>> {
  const parsed = validateWorkflowArguments(command, args);
  const config = loadWorkflowCliConfig(context.env, context.cwd);
  const scope = await resolveWorkspaceScope(context, config.allowedRoots);
  const orchestrator = new WorkflowOrchestrator(config.stateDir);
  try {
    switch (command) {
      case "run":
        return await runCommand(parsed.positionals[0]!, args, context, config, scope, orchestrator);
      case "script":
        return await scriptCommand(parsed.positionals[0]!, args, context, config, scope, orchestrator);
      case "status": {
        const workflowId = parsed.positionals[0]!;
        return { workflow: orchestrator.getForWorkspace(workflowId, scope) ?? notFound(workflowId) };
      }
      case "events": {
        const workflowId = parsed.positionals[0]!;
        const after = integerOption(args, "--after") ?? 0;
        const page = orchestrator.eventsForWorkspace(workflowId, scope, { after, limit: 1_000 });
        return { workflowId, events: page.events, cursor: page.nextCursor };
      }
      case "wait": {
        const workflowId = parsed.positionals[0]!;
        const timeoutMs = integerOption(args, "--timeout-ms") ?? DEFAULT_WAIT_TIMEOUT_MS;
        if (timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
          throw new CliInputError(`--timeout-ms must be between 0 and ${MAX_WAIT_TIMEOUT_MS}.`);
        }
        const before = orchestrator.getForWorkspace(workflowId, scope) ?? notFound(workflowId);
        const workflow = await orchestrator.waitForWorkspace(workflowId, scope, { timeoutMs });
        const after = integerOption(args, "--after");
        const page = after === undefined
          ? undefined
          : orchestrator.eventsForWorkspace(workflowId, scope, { after, limit: 1_000 });
        return {
          workflow,
          timedOut: !isTerminal(workflow) && !isTerminal(before),
          ...(page ? { events: page.events, cursor: page.nextCursor } : {}),
        };
      }
      case "cancel": {
        const workflowId = parsed.positionals[0]!;
        const workflow = orchestrator.cancelForWorkspace(workflowId, scope);
        await ensureSupervisor({
          stateDir: config.stateDir,
          cliEntrypoint: context.cliEntrypoint,
          env: context.env,
        });
        return { workflow };
      }
      default:
        throw new CliInputError(`Unknown workflows command: ${command}`);
    }
  } finally {
    orchestrator.close();
  }
}

async function runCommand(
  targetName: string,
  args: string[],
  context: WorkflowsCliContext,
  config: WorkflowCliConfig,
  scope: WorkflowWorkspaceScope,
  orchestrator: WorkflowOrchestrator,
): Promise<Record<string, unknown>> {
  const prompt = requiredOption(args, "--prompt");
  const model = optionalOption(args, "--model");
  const thinking = optionalOption(args, "--thinking");
  const timeoutMs = integerOption(args, "--timeout-ms");
  const access = optionalOption(args, "--access") ?? "read_only";
  const idempotencyKey = optionalOption(args, "--idempotency-key");
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > 24 * 60 * 60_000)) {
    throw new CliInputError("--timeout-ms must be between 1 and 86400000.");
  }
  if (access !== "read_only" && access !== "workspace_write") {
    throw new CliInputError("--access must be read_only or workspace_write.");
  }

  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const request = await createWorkflowSubmission({
    intent: {
      single: {
        target: targetName,
        prompt,
        model,
        thinking,
        access,
        timeoutMs,
      },
      idempotencyKey,
    },
    workspace: scope,
    profiles,
    worktreeRoot: config.worktreeRoot,
    environment: context.env,
  });
  const submitted = orchestrator.submitDetailed(request);
  const supervisor = await ensureSupervisor({
    stateDir: config.stateDir,
    cliEntrypoint: context.cliEntrypoint,
    env: context.env,
  });
  return {
    workflow: submitted.workflow,
    created: submitted.created,
    supervisor: {
      wakeGeneration: supervisor.requestedWakeGeneration,
      spawned: supervisor.spawned,
      ownerEpoch: supervisor.ownerEpoch ?? null,
    },
  };
}

async function scriptCommand(
  scriptPath: string,
  args: string[],
  context: WorkflowsCliContext,
  config: WorkflowCliConfig,
  scope: WorkflowWorkspaceScope,
  orchestrator: WorkflowOrchestrator,
): Promise<Record<string, unknown>> {
  const canonicalScript = await canonicalPath(resolve(context.cwd, scriptPath), "workflow script");
  if (!isInside(canonicalScript, scope.workspaceRoot)) {
    throw new WorkspaceDeniedError("Workflow script is outside DEVSPACE_WORKSPACE_ROOT.");
  }
  if (!canonicalScript.endsWith(".js") && !canonicalScript.endsWith(".mjs")) {
    throw new CliInputError("Workflow script must use a .js or .mjs extension.");
  }
  const source = await readFile(canonicalScript, "utf8");
  const runtimeArgs = parseJsonObjectOption(args, "--args-json");
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const result = await executeWorkflowRuntime({
    stateDir: config.stateDir,
    worktreeRoot: config.worktreeRoot,
    source,
    args: runtimeArgs,
    workspace: scope,
    profiles,
    idempotencyKey: optionalOption(args, "--idempotency-key"),
    environment: context.env,
    cliEntrypoint: context.cliEntrypoint,
    orchestrator,
  });
  if (result.run.status !== "succeeded") {
    const message = typeof result.run.error?.message === "string"
      ? result.run.error.message
      : `Workflow runtime ${result.run.id} failed`;
    throw new CliRuntimeError(`Workflow runtime ${result.run.id} failed: ${message}`);
  }
  return {
    runtime: result.run,
    created: result.created,
    replayedCalls: result.replayedCalls,
  };
}

async function resolveWorkspaceScope(
  context: Pick<WorkflowsCliContext, "cwd" | "env">,
  allowedRoots: string[],
): Promise<WorkflowWorkspaceScope> {
  const workspaceId = context.env.DEVSPACE_WORKSPACE_ID?.trim();
  if (!workspaceId) throw new WorkspaceDeniedError("DEVSPACE_WORKSPACE_ID is required for workflow commands.");
  const requestedRoot = resolve(context.env.DEVSPACE_WORKSPACE_ROOT || context.cwd);
  const workspaceRoot = await canonicalPath(requestedRoot, "workspace root");
  const cwd = await canonicalPath(context.cwd, "current directory");
  if (!isInside(cwd, workspaceRoot)) {
    throw new WorkspaceDeniedError("Current directory is outside DEVSPACE_WORKSPACE_ROOT.");
  }
  const canonicalAllowedRoots = await Promise.all(allowedRoots.map((root) => canonicalPath(root, "allowed root")));
  if (!canonicalAllowedRoots.some((root) => isInside(workspaceRoot, root))) {
    throw new WorkspaceDeniedError("Workspace root is outside configured allowed roots.");
  }
  return { workspaceId, workspaceRoot };
}

function loadWorkflowCliConfig(env: NodeJS.ProcessEnv, cwd: string): WorkflowCliConfig {
  const files = loadDevspaceFiles(env);
  const stateDir = resolve(expandHomePath(
    env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? join(homedir(), ".local", "share", "devspace"),
  ));
  const rawRoots = env.DEVSPACE_ALLOWED_ROOTS
    ? env.DEVSPACE_ALLOWED_ROOTS.split(",")
    : files.config.allowedRoots ?? [cwd];
  return {
    stateDir,
    worktreeRoot: resolve(expandHomePath(
      env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? join(homedir(), ".devspace", "worktrees"),
    )),
    allowedRoots: rawRoots.map((root) => resolve(expandHomePath(root.trim()))).filter(Boolean),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: resolveSubagentsFlag(files.config, env) === true,
  };
}

function validateWorkflowArguments(
  command: string,
  args: string[],
): { positionals: string[] } {
  const specifications: Record<string, { positionals: number; valueOptions: ReadonlySet<string> }> = {
    __supervisor: { positionals: 0, valueOptions: new Set(["--state-dir"]) },
    run: {
      positionals: 1,
      valueOptions: new Set([
        "--prompt",
        "--model",
        "--thinking",
        "--timeout-ms",
        "--access",
        "--idempotency-key",
      ]),
    },
    script: {
      positionals: 1,
      valueOptions: new Set(["--args-json", "--idempotency-key"]),
    },
    status: { positionals: 1, valueOptions: new Set() },
    events: { positionals: 1, valueOptions: new Set(["--after"]) },
    wait: { positionals: 1, valueOptions: new Set(["--timeout-ms", "--after"]) },
    cancel: { positionals: 1, valueOptions: new Set() },
  };
  const specification = specifications[command];
  if (!specification) throw new CliInputError(`Unknown workflows command: ${command}`);

  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index]!;
    if (!part.startsWith("--")) {
      positionals.push(part);
      continue;
    }
    const separator = part.indexOf("=");
    const name = separator === -1 ? part : part.slice(0, separator);
    if (name === "--json") {
      if (separator !== -1) throw new CliInputError("--json does not accept a value.");
    } else if (specification.valueOptions.has(name)) {
      const value = separator === -1 ? args[index + 1] : part.slice(separator + 1);
      if (!value || value.startsWith("--")) throw new CliInputError(`Missing value for ${name}.`);
      if (separator === -1) index += 1;
    } else {
      throw new CliInputError(`Unknown option for workflows ${command}: ${name}`);
    }
    if (seenOptions.has(name)) throw new CliInputError(`Duplicate option ${name}.`);
    seenOptions.add(name);
  }
  if (positionals.length !== specification.positionals) {
    throw new CliInputError(`workflows ${command} expects ${specification.positionals} positional argument${specification.positionals === 1 ? "" : "s"}.`);
  }
  return { positionals };
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value) throw new CliInputError(`Missing required option ${name}.`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (part === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CliInputError(`Missing value for ${name}.`);
      return value;
    }
    if (part?.startsWith(`${name}=`)) {
      const value = part.slice(name.length + 1);
      if (!value) throw new CliInputError(`Missing value for ${name}.`);
      return value;
    }
  }
  return undefined;
}

function parseJsonObjectOption(args: string[], name: string): JsonObject {
  const raw = optionalOption(args, name);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("value must be a JSON object");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new CliInputError(
      `${name} must be valid JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function integerOption(args: string[], name: string): number | undefined {
  const raw = optionalOption(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new CliInputError(`${name} must be an integer.`);
  return parsed;
}

function writeEnvelope(stdout: Writable, value: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ version: ENVELOPE_VERSION, ...value })}\n`);
}

function normalizeCliError(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof WorkspaceDeniedError) return { code: "workspace_denied", message: error.message, exitCode: 3 };
  if (error instanceof WorkflowNotFoundError) return { code: "not_found", message: error.message, exitCode: 4 };
  if (error instanceof WorkflowIdempotencyConflictError) return { code: "idempotency_conflict", message: error.message, exitCode: 5 };
  if (error instanceof CliRuntimeError) return { code: "runtime_failed", message: error.message, exitCode: 6 };
  if (error instanceof CliInputError || error instanceof WorkflowValidationError) {
    return { code: "invalid_input", message: error.message, exitCode: 2 };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  };
}

function notFound(workflowId: string): never {
  throw new WorkflowNotFoundError(workflowId);
}

function isTerminal(workflow: WorkflowRunRecord): boolean {
  return workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled";
}

async function canonicalPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new WorkspaceDeniedError(`Unable to canonicalize ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isInside(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === "" || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function workflowsHelp(): string {
  return [
    "DevSpace workflows",
    "",
    "Usage:",
    "  devspace workflows run <profile-or-provider> --prompt <task> --json [--idempotency-key <key>]",
    "  devspace workflows script <file.js> --json [--args-json <object>] [--idempotency-key <key>]",
    "  devspace workflows status <id> --json",
    "  devspace workflows wait <id> --json [--timeout-ms <ms>] [--after <cursor>]",
    "  devspace workflows events <id> --json [--after <cursor>]",
    "  devspace workflows cancel <id> --json",
    "",
  ].join("\n");
}

class CliInputError extends Error {}
class CliRuntimeError extends Error {}
class WorkspaceDeniedError extends Error {}
