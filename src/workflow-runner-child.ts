import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import type { WorkflowRunnerLimits } from "./workflow-runner.js";
import type { WorkflowScriptMeta } from "./workflow-script.js";

interface ErrorPayload { code: string; message: string; retryable?: boolean }
interface RunMessage {
  type: "run";
  source: string;
  args: unknown;
  meta: WorkflowScriptMeta;
  limits: WorkflowRunnerLimits;
}
interface HostResultMessage {
  type: "host-result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: ErrorPayload;
  fatal?: boolean;
}

let context: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let jsonObject: QuickJSHandle | undefined;
let jsonParse: QuickJSHandle | undefined;
let limits: WorkflowRunnerLimits | undefined;
let deadline = 0;
let nextCallId = 1;
let fatalError: ErrorPayload | undefined;
let logBytes = 0;
let logEntries = 0;
let shuttingDown = false;
const parentPid = process.ppid;
const pending = new Map<number, QuickJSDeferredPromise>();
let resolvePending: (() => void) | undefined;

process.once("disconnect", () => {
  if (!shuttingDown) process.exit(1);
});

process.on("message", (message: unknown) => {
  if (!isRecord(message)) return;
  if (message.type === "run") {
    if (runtime) return fail({ code: "WORKFLOW_PROTOCOL_ERROR", message: "Workflow runner received more than one run request." });
    void run(message as unknown as RunMessage);
  } else if (message.type === "host-result") {
    receiveHostResult(message as unknown as HostResultMessage);
  }
});

async function run(message: RunMessage): Promise<void> {
  try {
    limits = message.limits;
    deadline = Date.now() + limits.timeoutMs;
    const QuickJS = await getQuickJS();
    runtime = QuickJS.newRuntime();
    // ponytail: QuickJS exposes hard limits but no allocator-failure/high-water hook;
    // use a custom WASM allocator if caught OOM/stack exceptions must stay observable.
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    runtime.setInterruptHandler(() => {
      if (process.ppid !== parentPid) process.exit(1);
      if (fatalError) return true;
      if (Date.now() <= deadline) return false;
      fatalError = { code: "WORKFLOW_TIMEOUT", message: `Workflow exceeded ${limits?.timeoutMs ?? 0}ms.` };
      return true;
    });
    context = runtime.newContext();
    jsonObject = context.getProp(context.global, "JSON");
    jsonParse = context.getProp(jsonObject, "parse");
    exposeHostFunctions(context);

    const evaluation = context.evalCode(workflowProgram(message), "workflow.js");
    if (evaluation.error) {
      const error = quickJsError(evaluation.error);
      evaluation.error.dispose();
      return fail(classifyExecutionError(error));
    }

    const promise = evaluation.value;
    const resolved = context.resolvePromise(promise);
    pumpJobs();
    const result = await resolved;
    promise.dispose();
    if (fatalError) return fail(fatalError, true);
    if (result.error) {
      const error = quickJsError(result.error);
      result.error.dispose();
      return fail(classifyExecutionError(error));
    }
    if (pending.size > 0) await new Promise<void>((resolve) => { resolvePending = resolve; });
    if (fatalError) return fail(fatalError, true);

    const value = context.dump(result.value);
    result.value.dispose();
    const encoded = encodeJson(value, "Workflow result");
    if (Buffer.byteLength(encoded, "utf8") > limits.maxResultBytes) {
      return fail({ code: "WORKFLOW_RESULT_LIMIT", message: `Workflow result exceeds the ${limits.maxResultBytes}-byte limit.` }, true);
    }
    send({ type: "result", value: JSON.parse(encoded) });
  } catch (error) {
    fail(classifyExecutionError(error));
  } finally {
    cleanup();
  }
}

function exposeHostFunctions(vm: QuickJSContext): void {
  const hostCall = vm.newFunction("__hostCall", (kindHandle, payloadHandle) => {
    const deferred = vm.newPromise();
    try {
      if (!limits) throw new Error("Workflow limits are unavailable.");
      if (pending.size >= limits.maxOutstanding) {
        const error = {
          code: "WORKFLOW_OUTSTANDING_LIMIT",
          message: `Workflow has more than ${limits.maxOutstanding} outstanding host calls.`,
        };
        fatalError = error;
        reject(deferred, error);
        return deferred.handle;
      }
      const kind = vm.getString(kindHandle);
      if (kind !== "agent" && kind !== "workflow") throw new Error("Unknown workflow host call.");
      const payload = vm.dump(payloadHandle);
      const encoded = encodeJson(payload, "Workflow host call");
      if (Buffer.byteLength(encoded, "utf8") > limits.maxArgsBytes) {
        const error = {
          code: "WORKFLOW_SIZE_LIMIT",
          message: `Workflow host call exceeds the ${limits.maxArgsBytes}-byte limit.`,
        };
        fatalError = error;
        reject(deferred, error);
        return deferred.handle;
      }
      const id = nextCallId++;
      pending.set(id, deferred);
      const safePayload = JSON.parse(encoded) as Record<string, unknown>;
      send(kind === "agent"
        ? { type: "host-call", id, kind, prompt: safePayload.prompt, options: safePayload.options }
        : { type: "host-call", id, kind, name: safePayload.name, args: safePayload.args });
      return deferred.handle;
    } catch (error) {
      reject(deferred, toErrorPayload(error));
      return deferred.handle;
    }
  });
  vm.setProp(vm.global, "__hostCall", hostCall);
  hostCall.dispose();

  const emit = vm.newFunction("__emit", (typeHandle, dataHandle) => {
    if (!limits) throw new Error("Workflow limits are unavailable.");
    const eventType = vm.getString(typeHandle);
    const data = vm.dump(dataHandle);
    const encoded = encodeJson(data, "Workflow event");
    logEntries += 1;
    logBytes += Buffer.byteLength(encoded, "utf8") + eventType.length;
    if (logEntries > limits.maxLogEntries || logBytes > limits.maxLogBytes) {
      fatalError = {
        code: "WORKFLOW_LOG_LIMIT",
        message: `Workflow events exceed their configured limit.`,
      };
      throw Object.assign(new Error(fatalError.message), fatalError);
    }
    send({ type: "event", eventType, data: JSON.parse(encoded) });
  });
  vm.setProp(vm.global, "__emit", emit);
  emit.dispose();
}

function receiveHostResult(message: HostResultMessage): void {
  if (!context || !runtime) return;
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  if (pending.size === 0) {
    resolvePending?.();
    resolvePending = undefined;
  }
  let failed = false;
  try {
    if (message.ok) {
      const handle = valueHandle(context, message.value);
      deferred.resolve(handle);
      handle.dispose();
    } else {
      const error = message.error ?? { code: "WORKFLOW_HOST_ERROR", message: "Workflow host call failed." };
      if (message.fatal) fatalError = error;
      reject(deferred, error);
    }
    pumpJobs();
  } catch (error) {
    failed = true;
    fatalError = classifyExecutionError(error);
    fail(fatalError, true);
  } finally {
    // The guest owns the duplicated promise returned by the host callback.
    // This idempotently releases any host-side handle left after settlement.
    try { deferred.dispose(); } finally { if (failed) cleanup(); }
  }
}

function pumpJobs(): void {
  if (!runtime) return;
  const jobs = runtime.executePendingJobs();
  if (jobs.error) {
    const error = quickJsError(jobs.error);
    jobs.error.dispose();
    throw error;
  }
}

function workflowProgram(message: RunMessage): string {
  const args = JSON.stringify(message.args);
  const concurrency = message.meta.concurrency;
  return `
"use strict";
const args = Object.freeze(JSON.parse(${JSON.stringify(args)}));
const __error = error => ({
  code: typeof error?.code === "string" ? error.code : "WORKFLOW_STEP_FAILED",
  message: typeof error?.message === "string" ? error.message : String(error),
  retryable: error?.retryable === true,
});
const { agent, workflow, log, phase, parallel, pipeline } = (() => {
const hostCall = globalThis.__hostCall;
const emit = globalThis.__emit;
delete globalThis.__hostCall;
delete globalThis.__emit;
const agent = (prompt, options = {}) => hostCall("agent", { prompt, options });
const workflow = (name, workflowArgs = null) => hostCall("workflow", { name, args: workflowArgs });
const log = (...values) => emit("log", values.length === 1 ? values[0] : values);
const phase = async (name, run) => {
  if (typeof name !== "string" || !name || typeof run !== "function") throw new TypeError("phase(name, run) requires a name and function");
  emit("phase_started", { name });
  try {
    const value = await run((prompt, options = {}) => agent(prompt, { ...options, phase: name }));
    emit("phase_completed", { name });
    return value;
  } catch (error) {
    emit("phase_failed", { name, error: __error(error) });
    throw error;
  }
};
const parallel = async (items, worker, concurrency = ${concurrency}) => {
  if (!Array.isArray(items) || typeof worker !== "function") throw new TypeError("parallel(items, worker) requires an array and function");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("parallel concurrency must be between 1 and 16");
  const outcomes = new Array(items.length);
  let next = 0;
  const consume = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        outcomes[index] = { status: "completed", value: await worker(items[index], index) };
      } catch (error) {
        outcomes[index] = { status: "failed", error: __error(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return outcomes;
};
const pipeline = (items, ...stages) => {
  if (!Array.isArray(stages) || stages.some(stage => typeof stage !== "function")) throw new TypeError("pipeline stages must be functions");
  return parallel(items, async (item, index) => {
    let value = item;
    for (const stage of stages) value = await stage(value, item, index);
    return value;
  }, ${concurrency});
};
return Object.freeze({ agent, workflow, log, phase, parallel, pipeline });
})();
globalThis.__workflowResult = (async () => {
${message.source}
})();
globalThis.__workflowResult;
`;
}

function valueHandle(vm: QuickJSContext, value: unknown) {
  if (!jsonObject || !jsonParse) throw new Error("Workflow JSON parser is unavailable.");
  const encoded = encodeJson(value, "Host result");
  const encodedHandle = vm.newString(encoded);
  const result = vm.callFunction(jsonParse, jsonObject, encodedHandle);
  encodedHandle.dispose();
  if (result.error) {
    const error = quickJsError(result.error);
    result.error.dispose();
    throw error;
  }
  return result.value;
}

function reject(deferred: QuickJSDeferredPromise, error: ErrorPayload): void {
  if (!context) return;
  const handle = context.newError(error.message);
  const code = context.newString(error.code);
  const retryable = error.retryable ? context.true : context.false;
  context.setProp(handle, "code", code);
  context.setProp(handle, "retryable", retryable);
  code.dispose();
  deferred.reject(handle);
  handle.dispose();
}

function quickJsError(handle: Parameters<QuickJSContext["dump"]>[0]): Error & { code?: string; retryable?: boolean } {
  if (!context) return new Error("Workflow execution failed.");
  const value = context.dump(handle) as { name?: unknown; message?: unknown; stack?: unknown } | unknown;
  if (isRecord(value)) {
    const error: Error & { code?: string; retryable?: boolean } = new Error(
      typeof value.message === "string" ? value.message : "Workflow execution failed.",
    );
    if (typeof value.name === "string") error.name = value.name;
    if (typeof value.stack === "string") error.stack = value.stack;
    if (typeof value.code === "string") error.code = value.code;
    if (value.retryable === true) error.retryable = true;
    return error;
  }
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

function classifyExecutionError(error: unknown): ErrorPayload {
  if (fatalError) return fatalError;
  const payload = toErrorPayload(error);
  const text = payload.message.toLowerCase();
  if (text.includes("out of memory") || text.includes("cannot allocate memory")) {
    return { code: "WORKFLOW_MEMORY_LIMIT", message: "Workflow exceeded its memory limit." };
  }
  if (text.includes("stack overflow") || text.includes("stack size")) {
    return { code: "WORKFLOW_STACK_LIMIT", message: "Workflow exceeded its stack limit." };
  }
  if (text.includes("interrupted")) return { code: "WORKFLOW_TIMEOUT", message: "Workflow execution was interrupted." };
  return payload;
}

function toErrorPayload(error: unknown): ErrorPayload {
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
  return {
    code: typeof value?.code === "string" ? value.code : "WORKFLOW_EXECUTION_ERROR",
    message: typeof value?.message === "string" ? value.message : String(error),
    ...(value?.retryable === true ? { retryable: true } : {}),
  };
}

function encodeJson(value: unknown, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "number" && !Number.isFinite(current)) throw new TypeError("non-finite number");
      if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol" || current === undefined) {
        throw new TypeError(`unsupported ${typeof current}`);
      }
      return current;
    });
  } catch (error) {
    throw new TypeError(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON.`);
  return encoded;
}

function fail(error: ErrorPayload, fatal = false): void {
  send({ type: fatal || isFatal(error.code) ? "fatal" : "error", error });
}

function isFatal(code: string): boolean {
  return code.includes("LIMIT")
    || code.includes("INTERNAL")
    || code.includes("PROTOCOL")
    || code === "WORKFLOW_TIMEOUT"
    || code === "WORKFLOW_CANCELLED";
}

function cleanup(): void {
  for (const deferred of pending.values()) deferred.dispose();
  pending.clear();
  jsonParse?.dispose();
  jsonObject?.dispose();
  jsonParse = undefined;
  jsonObject = undefined;
  try { context?.dispose(); } catch { /* The process is disposable. */ }
  try { runtime?.dispose(); } catch { /* The process is disposable. */ }
  context = undefined;
  runtime = undefined;
  shuttingDown = true;
  if (process.connected) process.disconnect?.();
}

function send(message: unknown): void {
  if (!process.connected) return;
  try {
    process.send?.(message as never, () => undefined);
  } catch {
    if (!shuttingDown) process.exit(1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
