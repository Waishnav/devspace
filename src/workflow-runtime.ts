import { Worker } from "node:worker_threads";
import {
  agentOptionsSchema,
  assertJsonValue,
  jsonByteLength,
  validateSchemaBounds,
  workflowWorkerUrl,
} from "./workflow-schema.js";
import type {
  JsonValue,
  WorkflowAgentRequest,
  WorkflowBudgetSnapshot,
  WorkflowBridgeContext,
  WorkflowBridgeReply,
  WorkflowError,
  WorkflowNestedRequest,
  ParsedWorkflowScript,
  WorkflowRuntimeEvent,
  WorkflowRuntimeInput,
  WorkflowRuntimeLimits,
  WorkflowRuntimeResult,
} from "./workflow-types.js";
import { DEFAULT_WORKFLOW_RUNTIME_LIMITS } from "./workflow-types.js";

export class WorkflowRuntimeError extends Error implements WorkflowError {
  readonly code: string;
  readonly layer: WorkflowError["layer"];
  readonly retryable: boolean;
  readonly location?: WorkflowError["location"];

  constructor(error: WorkflowError) {
    super(error.message);
    this.name = "WorkflowRuntimeError";
    this.code = error.code;
    this.layer = error.layer;
    this.retryable = error.retryable;
    this.location = error.location;
  }
}

export async function preflightWorkflowScript(
  script: ParsedWorkflowScript,
  options: { limits?: Partial<WorkflowRuntimeLimits>; timeoutMs?: number } = {},
): Promise<void> {
  const limits = runtimeLimits(options.limits);
  const worker = new Worker(workflowWorkerUrl(), {
    workerData: { kind: "compile", body: script.body, filename: script.filename, limits },
    resourceLimits: {
      maxOldGenerationSizeMb: Math.max(16, Math.ceil(limits.guestHeapBytes / (1024 * 1024)) + 16),
      stackSizeMb: Math.max(1, Math.ceil(limits.guestStackBytes / (1024 * 1024))),
    },
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(runtimeError(
      "SCRIPT_CPU_LIMIT", "Workflow syntax preflight timed out.",
    ))), options.timeoutMs ?? Math.min(5_000, Math.max(2_000, limits.guestSliceMs * 2)));
    worker.once("message", (message: Record<string, unknown>) => {
      if (message.type === "compiled") finish(resolve);
      else if (message.type === "failed") finish(() => reject(new WorkflowRuntimeError(normalizeError(message.error))));
    });
    worker.once("error", (error) => finish(() => reject(toRuntimeError(error))));
    worker.once("exit", (code) => {
      if (!settled) finish(() => reject(runtimeError("WORKFLOW_FAILED", `Workflow preflight worker exited with code ${code}.`)));
    });
  });
}

export async function executeWorkflowScript(input: WorkflowRuntimeInput): Promise<WorkflowRuntimeResult> {
  const limits = runtimeLimits(input.limits);
  validateInput(input, limits);
  if (input.signal.aborted) throw runtimeError("WORKFLOW_STOPPED", "Workflow stopped.");

  const controller = new AbortController();
  const abort = () => controller.abort(runtimeError("WORKFLOW_STOPPED", "Workflow stopped."));
  input.signal.addEventListener("abort", abort, { once: true });

  const worker = new Worker(workflowWorkerUrl(), {
    workerData: {
      kind: "runtime",
      body: input.script.body,
      filename: input.script.filename,
      meta: input.script.meta,
      argsPresent: input.argsPresent,
      args: input.args,
      generation: input.generation,
      depth: input.depth,
      budget: input.budget,
      replay: input.replay,
      limits,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: Math.max(16, Math.ceil(limits.guestHeapBytes / (1024 * 1024)) + 16),
      stackSizeMb: Math.max(1, Math.ceil(limits.guestStackBytes / (1024 * 1024))),
    },
  });

  let settled = false;
  let resultReceived = false;
  let partial = false;
  let deliverySequence = 0;
  let eventChain = Promise.resolve();
  const requests = new Set<Promise<void>>();

  const stopWorker = (): void => {
    worker.postMessage({ type: "abort", generation: input.generation });
    void worker.terminate();
  };
  controller.signal.addEventListener("abort", stopWorker, { once: true });

  let fallbackDeadline: ReturnType<typeof setTimeout> | undefined;
  const deadline = input.callbacks.waitForActiveTimeout
    ? input.callbacks.waitForActiveTimeout(limits.runActiveMs, controller.signal)
    : new Promise<void>((resolveDeadline) => {
      fallbackDeadline = setTimeout(resolveDeadline, limits.runActiveMs);
    });
  void deadline.then(
    () => controller.abort(runtimeError("WORKFLOW_TIMEOUT", "Workflow active-time limit exceeded.")),
    (error) => { if (!controller.signal.aborted) controller.abort(error); },
  );

  try {
    return await new Promise<WorkflowRuntimeResult>((resolve, reject) => {
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        controller.abort(error);
        reject(error instanceof WorkflowRuntimeError ? error : toRuntimeError(error));
      };

      controller.signal.addEventListener("abort", () => {
        fail(controller.signal.reason ?? runtimeError("WORKFLOW_STOPPED", "Workflow stopped."));
      }, { once: true });

      worker.on("message", (message: Record<string, unknown>) => {
        if (settled || (message.generation !== undefined && message.generation !== input.generation)) return;
        if (message.type === "event") {
          eventChain = eventChain.then(() => input.callbacks.event(message.event as WorkflowRuntimeEvent));
          eventChain.catch(fail);
          return;
        }
        if (message.type === "request") {
          const operation = handleRequest(message).catch(fail).finally(() => requests.delete(operation));
          requests.add(operation);
          return;
        }
        if (message.type === "failed") {
          partial = true;
          fail(new WorkflowRuntimeError(normalizeError(message.error)));
          return;
        }
        if (message.type === "result") {
          resultReceived = true;
          void Promise.all([eventChain, ...requests]).then(() => {
            if (settled) return;
            try {
              const result = message.result;
              assertJsonValue(result, "Workflow result");
              if (jsonByteLength(result) > limits.runResultBytes) {
                fail(runtimeError("OUTPUT_LIMIT", "Workflow result exceeds the configured size limit."));
                return;
              }
              settled = true;
              resolve({
                result,
                omittedResult: message.omittedResult === true,
                partial: partial || message.partial === true,
              });
            } catch (error) {
              fail(error);
            }
          }, fail);
        }
      });
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (!settled && !resultReceived) {
          fail(runtimeError("WORKFLOW_FAILED", `Workflow worker exited before returning a result (code ${code}).`));
        }
      });

      async function handleRequest(message: Record<string, unknown>): Promise<void> {
        await eventChain;
        await input.callbacks.control?.("before_request");
        if (controller.signal.aborted) throw controller.signal.reason;

        const requestId = requiredSafeInteger(message.requestId, "requestId");
        const context: WorkflowBridgeContext = { generation: input.generation, requestId, signal: controller.signal };
        let reply: WorkflowBridgeReply;
        try {
          if (message.op === "agent") {
            reply = await input.callbacks.agent(parseAgentRequest(message, limits), context);
          } else if (message.op === "workflow") {
            reply = await input.callbacks.workflow(parseNestedRequest(message, limits), context);
          } else {
            throw runtimeError("WORKFLOW_SOURCE_INVALID", "Unknown workflow bridge operation.");
          }
          validateReply(reply, limits);
        } catch (error) {
          partial = true;
          await input.callbacks.control?.("before_delivery");
          const sequence = nextDeliverySequence();
          await input.callbacks.event({ type: "delivery", requestId, deliverySequence: sequence, replayed: false });
          worker.postMessage({
            type: "reply",
            generation: input.generation,
            requestId,
            ok: false,
            error: normalizeError(error),
            budget: latestBudget(input),
            replayed: false,
          });
          return;
        }

        await input.callbacks.control?.("before_delivery");
        if (controller.signal.aborted) throw controller.signal.reason;
        const sequence = nextDeliverySequence();
        await input.callbacks.event({
          type: "delivery",
          requestId,
          deliverySequence: sequence,
          replayed: reply.replayed === true,
        });
        worker.postMessage({
          type: "reply",
          generation: input.generation,
          requestId,
          ok: true,
          valueJson: JSON.stringify(reply.value),
          budget: reply.budget ?? latestBudget(input),
          replayed: reply.replayed === true,
        });
      }

      function nextDeliverySequence(): number {
        const sequence = input.callbacks.nextDeliverySequence?.() ?? ++deliverySequence;
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
          throw runtimeError("WORKFLOW_FAILED", "Invalid workflow delivery sequence.");
        }
        return sequence;
      }
    });
  } finally {
    if (fallbackDeadline) clearTimeout(fallbackDeadline);
    if (!controller.signal.aborted) controller.abort();
    input.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stopWorker);
    if (!settled) void worker.terminate();
    else await worker.terminate().catch(() => undefined);
  }
}

function parseAgentRequest(message: Record<string, unknown>, limits: WorkflowRuntimeLimits): WorkflowAgentRequest {
  const payload = parsePayload(message.payload, limits.promptBytes + limits.schemaBytes + 16 * 1024);
  const prompt = payload.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Agent prompt must contain non-whitespace text.");
  }
  if (Buffer.byteLength(prompt, "utf8") > limits.promptBytes) {
    throw runtimeError("OUTPUT_LIMIT", "Agent prompt exceeds the configured size limit.");
  }
  const options = agentOptionsSchema.parse(payload.options ?? {});
  if (options.schema !== undefined) validateSchemaBounds(options.schema, limits.schemaBytes, limits.schemaDepth);
  const inheritedPhase = typeof payload.phase === "string" ? payload.phase : undefined;
  if (inheritedPhase !== undefined && (inheritedPhase.length < 1 || inheritedPhase.length > 200)) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Agent phase is invalid.");
  }
  return { prompt, options, phase: options.phase ?? inheritedPhase, location: parseLocation(message.location) };
}

function parseNestedRequest(message: Record<string, unknown>, limits: WorkflowRuntimeLimits): WorkflowNestedRequest {
  const payload = parsePayload(message.payload, limits.argsBytes + 16 * 1024);
  const reference = payload.reference;
  if (typeof reference !== "string") {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)
      || Object.keys(reference).length !== 1 || typeof (reference as Record<string, unknown>).scriptPath !== "string"
      || !(reference as Record<string, string>).scriptPath.trim()
      || (reference as Record<string, string>).scriptPath.length > 8_192) {
      throw runtimeError("WORKFLOW_SOURCE_INVALID", "Nested workflow reference is invalid.");
    }
  } else if (!reference.trim()) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Nested workflow name cannot be empty.");
  }
  const argsPresent = payload.argsPresent === true;
  let args: JsonValue | undefined;
  if (argsPresent) {
    assertJsonValue(payload.args, "Nested workflow arguments");
    args = payload.args;
    if (jsonByteLength(args) > limits.argsBytes) {
      throw runtimeError("OUTPUT_LIMIT", "Nested workflow arguments exceed the configured size limit.");
    }
  }
  const phase = typeof payload.phase === "string" ? payload.phase : undefined;
  if (phase !== undefined && (phase.length < 1 || phase.length > 200)) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Nested workflow phase is invalid.");
  }
  return {
    reference: reference as string | { scriptPath: string },
    argsPresent,
    args,
    phase,
    location: parseLocation(message.location),
  };
}

function parseLocation(value: unknown): { line: number; column: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw runtimeError("WORKFLOW_SOURCE_INVALID", "Workflow source location is invalid.");
  const location = value as Record<string, unknown>;
  if (!Number.isSafeInteger(location.line) || (location.line as number) < 1
    || !Number.isSafeInteger(location.column) || (location.column as number) < 1) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Workflow source location is invalid.");
  }
  return { line: location.line as number, column: location.column as number };
}

function parsePayload(value: unknown, maxBytes: number): Record<string, unknown> {
  if (typeof value !== "string") throw runtimeError("WORKFLOW_SOURCE_INVALID", "Workflow bridge payload is invalid.");
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw runtimeError("OUTPUT_LIMIT", "Workflow bridge payload exceeds the configured size limit.");
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runtimeError("WORKFLOW_SOURCE_INVALID", "Workflow bridge payload is invalid.");
  }
  return parsed as Record<string, unknown>;
}

function validateReply(reply: WorkflowBridgeReply, limits: WorkflowRuntimeLimits): void {
  if (!reply || typeof reply !== "object" || !Object.hasOwn(reply, "value")) {
    throw runtimeError("WORKFLOW_FAILED", "Workflow bridge returned an invalid reply.");
  }
  assertJsonValue(reply.value, "Workflow bridge result");
  if (jsonByteLength(reply.value) > limits.agentResultBytes) {
    throw runtimeError("OUTPUT_LIMIT", "Workflow bridge result exceeds the configured size limit.");
  }
  if (reply.budget) validateBudget(reply.budget);
}

function validateInput(input: WorkflowRuntimeInput, limits: WorkflowRuntimeLimits): void {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new TypeError("generation must be a nonnegative safe integer.");
  validateBudget(input.budget);
  if (input.argsPresent) {
    assertJsonValue(input.args, "Workflow arguments");
    if (jsonByteLength(input.args) > limits.argsBytes) throw runtimeError("OUTPUT_LIMIT", "Workflow arguments exceed the configured size limit.");
  }
}

function runtimeLimits(overrides: WorkflowRuntimeInput["limits"]): WorkflowRuntimeLimits {
  const limits = { ...DEFAULT_WORKFLOW_RUNTIME_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return limits;
}

function validateBudget(budget: WorkflowBudgetSnapshot): void {
  if ((budget.total !== null && (!Number.isSafeInteger(budget.total) || budget.total <= 0))
    || !Number.isSafeInteger(budget.knownSpent) || budget.knownSpent < 0
    || typeof budget.complete !== "boolean") {
    throw new TypeError("Invalid workflow budget snapshot.");
  }
}

function latestBudget(input: WorkflowRuntimeInput): WorkflowBudgetSnapshot {
  const budget = input.callbacks.budget?.() ?? input.budget;
  validateBudget(budget);
  return budget;
}

function normalizeError(error: unknown): WorkflowError {
  if (error instanceof WorkflowRuntimeError) return error;
  if (error && typeof error === "object") {
    const candidate = error as Partial<WorkflowError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        layer: candidate.layer ?? "workflow",
        retryable: candidate.retryable ?? false,
        location: candidate.location,
      };
    }
  }
  return {
    code: "WORKFLOW_FAILED",
    message: error instanceof Error ? error.message : String(error),
    layer: "workflow",
    retryable: false,
  };
}

function toRuntimeError(error: unknown): WorkflowRuntimeError {
  return new WorkflowRuntimeError(normalizeError(error));
}

function runtimeError(code: string, message: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError({ code, message, layer: "workflow", retryable: false });
}

function requiredSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} is invalid.`);
  return value as number;
}
