import { spawn, type ChildProcess } from "node:child_process";
import type { LocalAgentProfile } from "../local-agent-profiles.js";
import { createWorkflowSubmission, type WorkflowAgentIntent } from "./submission.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import { ensureSupervisor } from "./supervisor-launch.js";
import {
  WorkflowRuntimeJournal,
  workflowRuntimeSourceHash,
  type WorkflowRuntimeBudget,
  type WorkflowRuntimeMetadata,
  type WorkflowRuntimeRun,
} from "./runtime-journal.js";
import { WorkflowValidationError } from "./store.js";
import type { JsonObject, JsonValue, WorkflowRunRecord, WorkflowWorkspaceScope } from "./types.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_ARGS_BYTES = 64 * 1024;
const DEFAULT_MAX_AGENT_CALLS = 16;
const MAX_AGENT_CALLS = 64;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const DEFAULT_RUNTIME_TIMEOUT_MS = 15 * 60_000;
const MAX_RUNTIME_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_LOG_CHARS = 16_384;
const MAX_EVENT_DATA_BYTES = 64 * 1024;
const CHILD_WORKFLOW_WAIT_MS = 300_000;

export interface ParsedWorkflowRuntimeSource {
  metadata: WorkflowRuntimeMetadata;
  budget: WorkflowRuntimeBudget;
  code: string;
}

export interface ExecuteWorkflowRuntimeInput {
  stateDir: string;
  worktreeRoot: string;
  source: string;
  args: JsonObject;
  workspace: WorkflowWorkspaceScope;
  profiles: LocalAgentProfile[];
  idempotencyKey?: string;
  environment?: NodeJS.ProcessEnv;
  cliEntrypoint?: string;
  orchestrator?: WorkflowOrchestrator;
  wakeSupervisor?: () => Promise<unknown>;
}

export interface ExecuteWorkflowRuntimeResult {
  run: WorkflowRuntimeRun;
  created: boolean;
  replayedCalls: number;
}

interface RuntimeAgentMessage {
  type: "agent";
  requestId: number;
  callIndex: number;
  request: unknown;
}

interface RuntimeEventMessage {
  type: "event";
  eventType: unknown;
  payload: unknown;
}

interface RuntimeResultMessage {
  type: "result";
  result: unknown;
}

interface RuntimeFailureMessage {
  type: "failure";
  error: unknown;
}

type RuntimeChildMessage = RuntimeAgentMessage | RuntimeEventMessage | RuntimeResultMessage | RuntimeFailureMessage;

export function parseWorkflowRuntimeSource(source: string): ParsedWorkflowRuntimeSource {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new WorkflowValidationError(`Workflow script exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  let header: Record<string, unknown> = {};
  if (firstContentIndex >= 0 && lines[firstContentIndex]!.trim().startsWith("// @devspace-workflow")) {
    const line = lines[firstContentIndex]!.trim();
    const raw = line.slice("// @devspace-workflow".length).trim();
    if (!raw) throw new WorkflowValidationError("Workflow metadata comment must contain JSON");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed)) throw new Error("metadata must be an object");
      header = parsed;
    } catch (error) {
      throw new WorkflowValidationError(
        `Invalid workflow metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    lines.splice(firstContentIndex, 1);
  }

  const allowed = new Set([
    "version",
    "name",
    "description",
    "maxAgentCalls",
    "maxConcurrency",
    "timeoutMs",
  ]);
  for (const key of Object.keys(header)) {
    if (!allowed.has(key)) throw new WorkflowValidationError(`Unknown workflow metadata field: ${key}`);
  }
  const version = header.version ?? 1;
  if (version !== 1) throw new WorkflowValidationError("Workflow metadata version must be 1");
  const name = optionalBoundedString(header.name, "Workflow name", 128);
  const description = optionalBoundedString(header.description, "Workflow description", 1_024);
  const metadata: WorkflowRuntimeMetadata = {
    version: 1,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
  const budget: WorkflowRuntimeBudget = {
    maxAgentCalls: boundedInteger(
      header.maxAgentCalls,
      DEFAULT_MAX_AGENT_CALLS,
      1,
      MAX_AGENT_CALLS,
      "Workflow maxAgentCalls",
    ),
    maxConcurrency: boundedInteger(
      header.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
      "Workflow maxConcurrency",
    ),
    timeoutMs: boundedInteger(
      header.timeoutMs,
      DEFAULT_RUNTIME_TIMEOUT_MS,
      1,
      MAX_RUNTIME_TIMEOUT_MS,
      "Workflow timeoutMs",
    ),
  };
  const code = lines.join("\n").trim();
  if (!/^export\s+default\s+(?:async\s+)?function\b/.test(code)) {
    throw new WorkflowValidationError(
      "Workflow script must export a default function declaration",
    );
  }
  return { metadata, budget, code };
}

export async function executeWorkflowRuntime(
  input: ExecuteWorkflowRuntimeInput,
): Promise<ExecuteWorkflowRuntimeResult> {
  validateJsonObject(input.args, "Workflow args", MAX_ARGS_BYTES);
  const parsed = parseWorkflowRuntimeSource(input.source);
  const journal = new WorkflowRuntimeJournal(input.stateDir);
  const orchestrator = input.orchestrator ?? new WorkflowOrchestrator(input.stateDir);
  const ownsOrchestrator = !input.orchestrator;
  const submitted = journal.submit({
    sourceHash: workflowRuntimeSourceHash(parsed.code),
    args: input.args,
    metadata: parsed.metadata,
    budget: parsed.budget,
    workspace: input.workspace,
    idempotencyKey: input.idempotencyKey,
  });
  if (!submitted.created && submitted.run.status === "succeeded") {
    journal.close();
    if (ownsOrchestrator) orchestrator.close();
    return { run: submitted.run, created: false, replayedCalls: 0 };
  }
  const run = submitted.created ? submitted.run : journal.resume(submitted.run.id);
  const activeWorkflowIds = new Set<string>();
  const scheduledOperations = new Set<Promise<void>>();
  let aborting = false;
  let replayedCalls = 0;
  let child: ChildProcess | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const finalResult = await new Promise<JsonValue>((resolve, reject) => {
      let settled = false;
      let activeAgents = 0;
      const queuedAgents: Array<() => void> = [];
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        action();
      };
      const runQueued = () => {
        while (!settled && activeAgents < parsed.budget.maxConcurrency && queuedAgents.length > 0) {
          activeAgents += 1;
          queuedAgents.shift()!();
        }
      };
      const scheduleAgent = (operation: () => Promise<void>) => {
        queuedAgents.push(() => {
          const scheduled = operation().finally(() => {
            activeAgents -= 1;
            scheduledOperations.delete(scheduled);
            runQueued();
          });
          scheduledOperations.add(scheduled);
          void scheduled;
        });
        runQueued();
      };

      child = spawnRuntimeChild();
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (!settled) {
          settle(() => reject(new Error(
            `Workflow runtime child exited before returning a result (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
          )));
        }
      });
      child.on("message", (raw: unknown) => {
        void handleChildMessage(raw).catch((error) => settle(() => reject(error)));
      });
      timeout = setTimeout(() => {
        settle(() => reject(new WorkflowValidationError(
          `Workflow runtime exceeded ${parsed.budget.timeoutMs} milliseconds`,
        )));
      }, parsed.budget.timeoutMs);

      child.send({
        type: "start",
        source: parsed.code,
        args: input.args,
        budget: parsed.budget,
      });

      async function handleChildMessage(raw: unknown): Promise<void> {
        if (!isPlainObject(raw) || typeof raw.type !== "string") {
          throw new WorkflowValidationError("Workflow runtime child sent an invalid message");
        }
        const message = raw as unknown as RuntimeChildMessage;
        if (message.type === "agent") {
          if (!Number.isSafeInteger(message.requestId) || Number(message.requestId) < 0) {
            throw new WorkflowValidationError("Workflow runtime request ID is invalid");
          }
          if (!Number.isSafeInteger(message.callIndex) || Number(message.callIndex) < 0) {
            throw new WorkflowValidationError("Workflow runtime call index is invalid");
          }
          if (message.callIndex >= parsed.budget.maxAgentCalls) {
            sendChild(child, {
              type: "agent_result",
              requestId: message.requestId,
              ok: false,
              error: { code: "budget_exceeded", message: "Workflow agent-call budget was exceeded" },
            });
            return;
          }
          scheduleAgent(async () => {
            try {
              const result = await executeAgentCall(message.callIndex, message.request);
              sendChild(child, { type: "agent_result", requestId: message.requestId, ok: true, result });
            } catch (error) {
              sendChild(child, {
                type: "agent_result",
                requestId: message.requestId,
                ok: false,
                error: normalizeError(error),
              });
            }
          });
          return;
        }
        if (message.type === "event") {
          const eventType = requiredBoundedString(message.eventType, "Runtime event type", 64);
          if (eventType !== "phase.started" && eventType !== "phase.completed" && eventType !== "log") {
            throw new WorkflowValidationError(`Unsupported workflow runtime event: ${eventType}`);
          }
          const payload = normalizeEventPayload(message.payload);
          journal.appendEvent(run.id, eventType, payload);
          return;
        }
        if (message.type === "result") {
          const result = normalizeJsonValue(message.result, "Workflow result");
          settle(() => resolve(result));
          return;
        }
        if (message.type === "failure") {
          const error = normalizeChildError(message.error);
          settle(() => reject(new WorkflowValidationError(error.message)));
          return;
        }
        throw new WorkflowValidationError("Workflow runtime child sent an unsupported message");
      }

      async function executeAgentCall(callIndex: number, rawRequest: unknown): Promise<JsonValue> {
        const request = normalizeAgentRequest(rawRequest);
        const journaled = journal.beginCall({ runId: run.id, callIndex, request: request as unknown as JsonObject });
        if (journaled.replayed) replayedCalls += 1;
        if (journaled.call.status === "succeeded") return journaled.call.result ?? null;
        if (journaled.call.status === "failed") {
          throw new WorkflowValidationError(
            typeof journaled.call.error?.message === "string"
              ? journaled.call.error.message
              : `Workflow agent call ${callIndex} previously failed`,
          );
        }

        let workflow: WorkflowRunRecord;
        if (journaled.call.workflowRunId) {
          workflow = orchestrator.getForWorkspace(journaled.call.workflowRunId, input.workspace)
            ?? (() => { throw new WorkflowValidationError("Journaled child workflow is unavailable"); })();
        } else {
          const submission = await createWorkflowSubmission({
            intent: {
              single: request,
              idempotencyKey: `runtime:${run.id}:agent:${callIndex}`,
            },
            workspace: input.workspace,
            profiles: input.profiles,
            worktreeRoot: input.worktreeRoot,
            environment: input.environment,
          });
          const childWorkflow = orchestrator.submitDetailed(submission).workflow;
          journal.markCallRunning(run.id, callIndex, childWorkflow.id);
          workflow = childWorkflow;
          await wakeSupervisor(input);
        }
        activeWorkflowIds.add(workflow.id);
        if (aborting && !isTerminal(workflow)) {
          orchestrator.cancelForWorkspace(workflow.id, input.workspace);
          await wakeSupervisor(input);
        }
        while (!isTerminal(workflow)) {
          workflow = await orchestrator.waitForWorkspace(workflow.id, input.workspace, {
            timeoutMs: Math.min(CHILD_WORKFLOW_WAIT_MS, parsed.budget.timeoutMs),
          });
        }
        activeWorkflowIds.delete(workflow.id);
        if (workflow.status !== "succeeded") {
          const error = {
            code: stringField(workflow.error, "code") ?? workflow.status,
            message: stringField(workflow.error, "message") ?? `Child workflow ${workflow.id} ${workflow.status}`,
            workflowId: workflow.id,
          } satisfies JsonObject;
          journal.completeCall(run.id, callIndex, "failed", error);
          throw new WorkflowValidationError(String(error.message));
        }
        const result = {
          workflowId: workflow.id,
          status: workflow.status,
          finalResponse: stringField(workflow.result as JsonObject | undefined, "finalResponse") ?? "",
        } satisfies JsonObject;
        journal.completeCall(run.id, callIndex, "succeeded", result);
        return result;
      }
    });
    child?.kill("SIGTERM");
    return {
      run: journal.completeRun(run.id, "succeeded", finalResult),
      created: submitted.created,
      replayedCalls,
    };
  } catch (error) {
    aborting = true;
    child?.kill("SIGKILL");
    for (const workflowId of activeWorkflowIds) {
      try {
        orchestrator.cancelForWorkspace(workflowId, input.workspace);
      } catch {
        // The child may have terminalized while the runtime was aborting.
      }
    }
    if (activeWorkflowIds.size > 0 || scheduledOperations.size > 0) {
      await wakeSupervisor(input).catch(() => undefined);
    }
    await Promise.allSettled([...scheduledOperations]);
    const normalized = normalizeError(error);
    return {
      run: journal.completeRun(run.id, "failed", normalized),
      created: submitted.created,
      replayedCalls,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    journal.close();
    if (ownsOrchestrator) orchestrator.close();
  }
}

async function wakeSupervisor(input: ExecuteWorkflowRuntimeInput): Promise<unknown> {
  if (input.wakeSupervisor) return input.wakeSupervisor();
  return ensureSupervisor({
    stateDir: input.stateDir,
    cliEntrypoint: input.cliEntrypoint,
    env: input.environment,
  });
}

function spawnRuntimeChild(): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--permission",
      "--max-old-space-size=64",
      "--input-type=module",
      "--eval",
      RUNTIME_CHILD_SOURCE,
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {},
      shell: false,
      windowsHide: true,
    },
  );
}

function sendChild(child: ChildProcess | undefined, message: JsonObject): void {
  if (!child?.connected) return;
  child.send(message);
}

function normalizeAgentRequest(value: unknown): WorkflowAgentIntent {
  if (!isPlainObject(value)) throw new WorkflowValidationError("agent() requires an options object");
  const allowed = new Set(["target", "prompt", "model", "thinking", "access", "timeoutMs", "retry"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkflowValidationError(`Unknown agent() option: ${key}`);
  }
  const target = requiredBoundedString(value.target, "agent target", 128);
  const prompt = requiredBoundedString(value.prompt, "agent prompt", 200_000);
  const model = optionalBoundedString(value.model, "agent model", 256);
  const thinking = optionalBoundedString(value.thinking, "agent thinking", 64);
  const access = value.access === undefined ? undefined : requiredBoundedString(value.access, "agent access", 32);
  if (access !== undefined && access !== "read_only" && access !== "workspace_write") {
    throw new WorkflowValidationError("agent access must be read_only or workspace_write");
  }
  const timeoutMs = value.timeoutMs === undefined
    ? undefined
    : boundedInteger(value.timeoutMs, 1, 1, MAX_RUNTIME_TIMEOUT_MS, "agent timeoutMs");
  let retry: WorkflowAgentIntent["retry"];
  if (value.retry !== undefined) {
    if (!isPlainObject(value.retry)) throw new WorkflowValidationError("agent retry must be an object");
    const retryAllowed = new Set(["maxAttempts", "retryOn", "backoffMs"]);
    for (const key of Object.keys(value.retry)) {
      if (!retryAllowed.has(key)) throw new WorkflowValidationError(`Unknown agent retry option: ${key}`);
    }
    const retryOn = value.retry.retryOn;
    if (retryOn !== undefined && (!Array.isArray(retryOn) || retryOn.some(
      (entry) => entry !== "provider_failed" && entry !== "timed_out",
    ))) {
      throw new WorkflowValidationError("agent retryOn contains an unsupported failure class");
    }
    retry = {
      maxAttempts: value.retry.maxAttempts === undefined
        ? undefined
        : boundedInteger(value.retry.maxAttempts, 1, 1, 10, "agent retry maxAttempts"),
      retryOn: retryOn as Array<"provider_failed" | "timed_out"> | undefined,
      backoffMs: value.retry.backoffMs === undefined
        ? undefined
        : boundedInteger(value.retry.backoffMs, 0, 0, 60_000, "agent retry backoffMs"),
    };
  }
  return { target, prompt, model, thinking, access, timeoutMs, retry };
}

function normalizeEventPayload(value: unknown): JsonObject {
  if (!isPlainObject(value)) throw new WorkflowValidationError("Workflow runtime event payload must be an object");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_DATA_BYTES) {
    throw new WorkflowValidationError("Workflow runtime event payload is too large");
  }
  if (typeof value.message === "string" && value.message.length > MAX_LOG_CHARS) {
    throw new WorkflowValidationError(`Workflow runtime log exceeds ${MAX_LOG_CHARS} characters`);
  }
  return JSON.parse(serialized) as JsonObject;
}

function normalizeJsonValue(value: unknown, label: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_DATA_BYTES) {
    throw new WorkflowValidationError(`${label} exceeds ${MAX_EVENT_DATA_BYTES} bytes`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function validateJsonObject(value: JsonObject, label: string, maxBytes: number): void {
  if (!isPlainObject(value)) throw new WorkflowValidationError(`${label} must be an object`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new WorkflowValidationError(`${label} exceeds ${maxBytes} bytes`);
  }
}

function normalizeError(error: unknown): JsonObject {
  return {
    code: error instanceof WorkflowValidationError ? "invalid_workflow" : "runtime_failed",
    message: error instanceof Error ? error.message.slice(0, MAX_LOG_CHARS) : String(error).slice(0, MAX_LOG_CHARS),
  };
}

function normalizeChildError(error: unknown): { message: string } {
  if (!isPlainObject(error) || typeof error.message !== "string") {
    return { message: "Workflow script failed" };
  }
  return { message: error.message.slice(0, MAX_LOG_CHARS) };
}

function requiredBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new WorkflowValidationError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new WorkflowValidationError(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBoundedString(value, label, maximum);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new WorkflowValidationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTerminal(workflow: WorkflowRunRecord): boolean {
  return workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled";
}

function stringField(value: JsonObject | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

const RUNTIME_CHILD_SOURCE = String.raw`
import vm from "node:vm";

let nextRequestId = 0;
let nextCallIndex = 0;
const pending = new Map();

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "agent_result") {
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(Object.assign(new Error(message.error?.message || "Agent call failed"), message.error));
    return;
  }
  if (message.type === "start") void start(message);
});

function rpcAgent(request) {
  const requestId = nextRequestId++;
  const callIndex = nextCallIndex++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send({ type: "agent", requestId, callIndex, request });
  });
}

function emit(eventType, payload) {
  process.send({ type: "event", eventType, payload });
}

async function start(message) {
  try {
    const transformed = message.source.replace(
      /^export\s+default\s+/,
      "globalThis.__devspaceWorkflow = ",
    );
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, {
      name: "devspace-workflow-runtime",
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new vm.Script('"use strict";\n' + transformed, {
      filename: "workflow.js",
    });
    script.runInContext(context, { timeout: 1_000 });
    const workflow = context.__devspaceWorkflow;
    if (typeof workflow !== "function") throw new Error("Default export must be a function");

    const api = Object.freeze({
      args: deepFreeze(message.args),
      budget: deepFreeze(message.budget),
      agent: (request) => rpcAgent(request),
      parallel: async (tasks) => {
        if (!Array.isArray(tasks)) throw new Error("parallel() requires an array of functions");
        return Promise.all(tasks.map((task) => {
          if (typeof task !== "function") throw new Error("parallel() entries must be functions");
          return task();
        }));
      },
      pipeline: async (tasks, initialValue) => {
        if (!Array.isArray(tasks)) throw new Error("pipeline() requires an array of functions");
        let value = initialValue;
        for (const task of tasks) {
          if (typeof task !== "function") throw new Error("pipeline() entries must be functions");
          value = await task(value);
        }
        return value;
      },
      phase: async (name, task) => {
        if (typeof name !== "string" || !name.trim()) throw new Error("phase() requires a name");
        if (typeof task !== "function") throw new Error("phase() requires a function");
        emit("phase.started", { name: name.trim() });
        const result = await task();
        emit("phase.completed", { name: name.trim() });
        return result;
      },
      log: (message, data = null) => {
        if (typeof message !== "string") throw new Error("log() requires a string message");
        emit("log", { message, data });
      },
    });
    const result = await workflow(api);
    if (pending.size > 0) {
      throw new Error("Workflow returned before all agent() calls were awaited");
    }
    process.send({ type: "result", result: result === undefined ? null : result });
  } catch (error) {
    process.send({
      type: "failure",
      error: { name: error?.name || "Error", message: error?.message || String(error) },
    });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
`;
