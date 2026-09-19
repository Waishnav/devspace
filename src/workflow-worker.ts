import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSRuntime } from "quickjs-emscripten";
import type {
  JsonSchema,
  JsonValue,
  WorkflowBudgetSnapshot,
  WorkflowError,
  WorkflowRuntimeEvent,
  WorkflowRuntimeLimits,
  WorkflowReplayInput,
} from "./workflow-types.js";

interface RuntimeWorkerData {
  kind: "runtime";
  body: string;
  filename: string;
  meta: JsonValue;
  argsPresent: boolean;
  args?: JsonValue;
  generation: number;
  depth: 0 | 1;
  budget: WorkflowBudgetSnapshot;
  replay?: WorkflowReplayInput;
  limits: WorkflowRuntimeLimits;
}

interface SchemaWorkerData {
  kind: "schema";
  schema: JsonSchema;
  value?: JsonValue;
  compileOnly?: boolean;
}

interface CompileWorkerData {
  kind: "compile";
  body: string;
  filename: string;
  limits: WorkflowRuntimeLimits;
}

type WorkerInput = RuntimeWorkerData | SchemaWorkerData | CompileWorkerData;

if (!isMainThread && parentPort) {
  const input = workerData as WorkerInput;
  if (input.kind === "schema") runSchemaValidation(input);
  else if (input.kind === "compile") runCompileValidation(input);
  else void runRuntime(input).catch((error) => {
    parentPort?.postMessage({ type: "failed", error: safeError(error) });
  });
}

function runCompileValidation(input: CompileWorkerData): void {
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  try {
    void getQuickJS().then((QuickJS) => {
      const started = performance.now();
      runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(input.limits.guestHeapBytes);
      runtime.setMaxStackSize(input.limits.guestStackBytes);
      runtime.removeModuleLoader();
      runtime.setInterruptHandler(() => performance.now() - started > input.limits.guestSliceMs);
      context = runtime.newContext();
      const source = prelude({
        kind: "runtime",
        body: input.body,
        filename: input.filename,
        meta: { name: "preflight", description: "preflight" },
        argsPresent: false,
        generation: 0,
        depth: 0,
        budget: { total: null, knownSpent: 0, complete: true },
        limits: input.limits,
      });
      const bodyMarkerOffset = source.indexOf("/*__DEVSPACE_WORKFLOW_BODY__*/");
      const sourceLineOffset = source.slice(0, bodyMarkerOffset).split(/\r\n|\r|\n/).length;
      const result = context.evalCode(source, input.filename, { type: "global", compileOnly: true });
      if (result.error) {
        const dumped = context.dump(result.error) as unknown;
        result.error.dispose();
        const error = guestError(dumped, sourceLineOffset, input.filename);
        throw error.code === "WORKFLOW_FAILED" ? { ...error, code: "WORKFLOW_SYNTAX_ERROR" } : error;
      }
      result.value.dispose();
      parentPort?.postMessage({ type: "compiled" });
      context.dispose();
      runtime.dispose();
      context = undefined;
      runtime = undefined;
    }).catch((error) => {
      context?.dispose();
      runtime?.dispose();
      parentPort?.postMessage({ type: "failed", error: safeError(error) });
    });
  } catch (error) {
    context?.dispose();
    runtime?.dispose();
    parentPort?.postMessage({ type: "failed", error: safeError(error) });
  }
}

function runSchemaValidation(input: SchemaWorkerData): void {
  try {
    assertSchemaIsPossible(input.schema);
    const dialect = typeof input.schema === "object" && input.schema !== null
      ? input.schema.$schema
      : undefined;
    const draft7 = dialect === "http://json-schema.org/draft-07/schema#"
      || dialect === "https://json-schema.org/draft-07/schema";
    const draft2020 = dialect === undefined || dialect === "https://json-schema.org/draft/2020-12/schema"
      || dialect === "https://json-schema.org/draft/2020-12/schema#";
    if (!draft7 && !draft2020) {
      throw Object.assign(new Error(`Unsupported JSON Schema dialect: ${String(dialect)}`), {
        code: "SCHEMA_UNSUPPORTED",
      });
    }
    const ajv = draft7
      ? new Ajv({ strict: true, allErrors: false })
      : new Ajv2020({ strict: true, allErrors: false });
    const validate = ajv.compile(input.schema);
    if (input.compileOnly) {
      parentPort?.postMessage({ valid: true });
      return;
    }
    const valid = validate(input.value);
    parentPort?.postMessage({
      valid,
      value: valid ? input.value : undefined,
      errors: valid ? undefined : (validate.errors ?? []).slice(0, 20).map((error: { instancePath: string; message?: string }) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`),
    });
  } catch (error) {
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "SCHEMA_INVALID",
    });
  }
}

function assertSchemaIsPossible(schema: JsonSchema): void {
  if (schema === true || schema === false) return;
  const visit = (node: JsonValue): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [minimum, maximum] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
      const low = node[minimum];
      const high = node[maximum];
      if (typeof low === "number" && typeof high === "number" && low > high) {
        throw new Error(`${minimum} cannot exceed ${maximum}.`);
      }
    }
    if (node.additionalProperties === false && Array.isArray(node.required)) {
      const properties = node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
        ? node.properties
        : {};
      const patterns = node.patternProperties && typeof node.patternProperties === "object" && !Array.isArray(node.patternProperties)
        ? Object.keys(node.patternProperties)
        : [];
      for (const required of node.required) {
        if (typeof required === "string" && !Object.hasOwn(properties, required)
          && !patterns.some((pattern) => new RegExp(pattern, "u").test(required))) {
          throw new Error(`Required property '${required}' is forbidden by additionalProperties: false.`);
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
}

async function runRuntime(input: RuntimeWorkerData): Promise<void> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.limits.guestHeapBytes);
  runtime.setMaxStackSize(input.limits.guestStackBytes);
  runtime.removeModuleLoader();

  let sliceStarted = 0;
  let totalCpuMs = 0;
  runtime.setInterruptHandler(() => {
    const elapsed = performance.now() - sliceStarted;
    return elapsed > input.limits.guestSliceMs || totalCpuMs + elapsed > input.limits.guestTotalCpuMs;
  });

  const context = runtime.newContext();
  const runtimeSource = prelude(input);
  const bodyMarkerOffset = runtimeSource.indexOf("/*__DEVSPACE_WORKFLOW_BODY__*/");
  const sourceLineOffset = runtimeSource.slice(0, bodyMarkerOffset).split(/\r\n|\r|\n/).length;
  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextRequestId = 1;
  let pendingResult: { result: JsonValue; omittedResult: boolean; partial: boolean } | undefined;
  let partial = false;
  let phase: string | undefined;
  let agentCount = 0;
  let workflowCount = 0;
  let logBytes = 0;
  let eventCount = 0;
  let replayEventIndex = 0;
  let budget = input.budget;
  let observationIndex = 0;
  let replayActive = input.replay !== undefined;
  let stopped = false;

  const postEvent = (event: WorkflowRuntimeEvent): void => {
    eventCount += 1;
    if (eventCount > input.limits.eventsPerRun) throw workflowError("LOG_LIMIT", "Workflow event quota exceeded.");
    parentPort?.postMessage({ type: "event", generation: input.generation, event });
  };

  const postReplayableEvent = (event: { type: "phase"; title: string } | { type: "log"; message: string }): void => {
    const replayed = replayActive ? input.replay?.events?.[replayEventIndex] : undefined;
    const matches = event.type === "phase"
      ? replayed?.type === "phase" && replayed.title === event.title
      : replayed?.type === "log" && replayed.message === event.message;
    if (matches) {
      replayEventIndex += 1;
      postEvent({ ...event, replayed: true });
      return;
    }
    if (replayActive) {
      replayActive = false;
      postEvent({ type: "replay_diverged", reason: `${event.type} event changed.` });
    }
    postEvent({ ...event, replayed: false });
  };

  const expose = (name: string, fn: Parameters<QuickJSContext["newFunction"]>[1]): void => {
    const handle = context.newFunction(name, fn);
    context.defineProp(context.global, name, {
      value: handle,
      configurable: false,
      enumerable: false,
    });
    handle.dispose();
  };

  expose("__hostAgent", (payloadHandle, stackHandle) => {
    if (agentCount >= input.limits.maxAgents) throw workflowError("AGENT_LIMIT", "Workflow agent invocation limit exceeded.");
    agentCount += 1;
    return request("agent", context.getString(payloadHandle), locationFromStack(context.getString(stackHandle)));
  });
  expose("__hostWorkflow", (payloadHandle, stackHandle) => {
    if (input.depth >= 1) throw workflowError("NESTING_LIMIT", "Nested workflows may not invoke another workflow.");
    if (workflowCount >= input.limits.maxNestedWorkflows) {
      throw workflowError("AGENT_LIMIT", "Nested workflow invocation limit exceeded.");
    }
    workflowCount += 1;
    return request("workflow", context.getString(payloadHandle), locationFromStack(context.getString(stackHandle)));
  });
  expose("__hostPhase", (titleHandle) => {
    phase = context.getString(titleHandle);
    if (phase.length < 1 || phase.length > 200) {
      throw workflowError("WORKFLOW_SOURCE_INVALID", "Workflow phase is invalid.");
    }
    postReplayableEvent({ type: "phase", title: phase });
  });
  expose("__hostLog", (messageHandle) => {
    const message = context.getString(messageHandle);
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > input.limits.logMessageBytes || logBytes + bytes > input.limits.logTotalBytes) {
      throw workflowError("LOG_LIMIT", "Workflow log quota exceeded.");
    }
    logBytes += bytes;
    postReplayableEvent({ type: "log", message });
  });
  expose("__hostCombinatorError", (kindHandle, indexHandle, errorHandle, stackHandle) => {
    partial = true;
    const combinator = context.getString(kindHandle);
    const index = context.getNumber(indexHandle);
    const message = context.getString(errorHandle).slice(0, 2_000);
    if ((combinator !== "parallel" && combinator !== "pipeline")
      || !Number.isSafeInteger(index) || index < 0 || index >= input.limits.maxCombinatorItems) {
      throw workflowError("WORKFLOW_SOURCE_INVALID", "Invalid combinator failure event.");
    }
    postEvent({
      type: "combinator_error",
      combinator,
      index,
      error: {
        code: "TASK_FAILED",
        message,
        layer: "script",
        retryable: false,
        location: locationFromStack(context.getString(stackHandle)),
      },
    });
  });
  expose("__hostBudgetRead", (getterHandle, stackHandle) => {
    const getter = context.getString(getterHandle) as "spent" | "remaining";
    if (getter !== "spent" && getter !== "remaining") {
      throw workflowError("WORKFLOW_SOURCE_INVALID", "Unknown budget getter.");
    }
    const location = locationFromStack(context.getString(stackHandle));
    const replayed = replayActive ? input.replay?.budgetObservations?.[observationIndex] : undefined;
    const replayMatches = replayed?.getter === getter
      && (replayed.location === undefined || sameLocation(replayed.location, location));
    if (replayActive && !replayMatches) {
      replayActive = false;
      if (!budget.complete) postEvent({ type: "replay_diverged", reason: "Budget observation changed." });
    }
    if (!replayMatches && !budget.complete) throw workflowError("USAGE_UNAVAILABLE", "Provider output-token usage is unavailable.");
    const value = replayMatches
      ? replayed.value === "Infinity" ? Number.POSITIVE_INFINITY : replayed.value
      : getter === "spent"
        ? budget.knownSpent
        : budget.total === null ? Number.POSITIVE_INFINITY : Math.max(0, budget.total - budget.knownSpent);
    postEvent({
      type: "budget_observation",
      getter,
      observationIndex: observationIndex++,
      value: Number.isFinite(value) ? value : "Infinity",
      location,
      replayed: replayMatches,
    });
    return context.newNumber(value);
  });

  function request(op: "agent" | "workflow", payload: string, location?: { line: number; column: number }) {
    if (pending.size >= input.limits.maxPendingRequests) {
      throw workflowError("AGENT_LIMIT", "Too many unresolved workflow requests.");
    }
    const requestId = nextRequestId++;
    const deferred = context.newPromise();
    pending.set(requestId, deferred);
    parentPort?.postMessage({
      type: "request",
      op,
      requestId,
      generation: input.generation,
      payload,
      phase,
      location,
    });
    return deferred.handle;
  }

  function locationFromStack(stack: string): { line: number; column: number } | undefined {
    return errorLocation(stack, sourceLineOffset, input.filename);
  }

  const onMessage = (message: Record<string, unknown>): void => {
    if (message.generation !== input.generation) return;
    if (message.type === "abort") {
      stopped = true;
      for (const deferred of pending.values()) rejectDeferred(deferred, workflowError("WORKFLOW_STOPPED", "Workflow stopped."));
      pending.clear();
      pump(runtime);
      finish();
      return;
    }
    if (message.type !== "reply" || typeof message.requestId !== "number") return;
    const deferred = pending.get(message.requestId);
    if (!deferred) return;
    pending.delete(message.requestId);
    if (message.replayed !== true) replayActive = false;
    if (isBudget(message.budget)) budget = message.budget;
    if (message.ok) {
      const value = parseJsonHandle(context, String(message.valueJson));
      deferred.resolve(value);
      value.dispose();
    } else {
      partial = true;
      rejectDeferred(deferred, isWorkflowError(message.error) ? message.error : workflowError("WORKFLOW_FAILED", "Workflow request failed."));
    }
    deferred.dispose();
    pump(runtime);
    readResult();
    finish();
  };
  parentPort?.on("message", onMessage);

  try {
    evaluate(context, runtime, runtimeSource, input.filename);
    readResult();
    finish();
  } catch (error) {
    cleanup();
    throw error;
  }

  function readResult(): void {
    if (pendingResult || stopped) return;
    const handle = context.getProp(context.global, "__workflowResult");
    const state = context.getPromiseState(handle);
    handle.dispose();
    if (state.type === "pending") return;
    if (state.type === "rejected") {
      const error = context.dump(state.error) as unknown;
      state.error.dispose();
      throw guestError(error, sourceLineOffset, input.filename);
    }
    const raw = context.dump(state.value) as { valueJson: string; omittedResult: boolean };
    state.value.dispose();
    pendingResult = { result: JSON.parse(raw.valueJson) as JsonValue, omittedResult: raw.omittedResult, partial };
  }

  function finish(): void {
    if (stopped) {
      cleanup();
      parentPort?.postMessage({ type: "failed", error: workflowError("WORKFLOW_STOPPED", "Workflow stopped.") });
      return;
    }
    if (!pendingResult) {
      if (pending.size === 0) throw workflowError("WORKFLOW_FAILED", "Workflow script stalled with no outstanding operations.");
      return;
    }
    if (pending.size > 0) return;
    const result = { ...pendingResult, partial: pendingResult.partial || partial };
    cleanup();
    parentPort?.postMessage({ type: "result", generation: input.generation, ...result });
  }

  function cleanup(): void {
    parentPort?.off("message", onMessage);
    for (const deferred of pending.values()) deferred.dispose();
    pending.clear();
    context.dispose();
    runtime.dispose();
  }

  function evaluate(vm: QuickJSContext, qjsRuntime: QuickJSRuntime, code: string, filename: string): void {
    sliceStarted = performance.now();
    const result = vm.evalCode(code, filename, { type: "global" });
    totalCpuMs += performance.now() - sliceStarted;
    if (result.error) {
      const dumped = vm.dump(result.error) as unknown;
      result.error.dispose();
      throw guestError(dumped, sourceLineOffset, input.filename);
    }
    result.value.dispose();
    pump(qjsRuntime);
  }

  function pump(qjsRuntime: QuickJSRuntime): void {
    while (qjsRuntime.hasPendingJob()) {
      sliceStarted = performance.now();
      const result = qjsRuntime.executePendingJobs(1_000);
      totalCpuMs += performance.now() - sliceStarted;
      if (result.error) {
        const dumped = result.error.context.dump(result.error) as unknown;
        result.error.dispose();
        throw guestError(dumped, sourceLineOffset, input.filename);
      }
      if (totalCpuMs >= input.limits.guestTotalCpuMs) {
        throw workflowError("SCRIPT_CPU_LIMIT", "Workflow CPU limit exceeded.");
      }
    }
  }
}

function prelude(input: RuntimeWorkerData): string {
  const metaJson = JSON.stringify(input.meta);
  const argsExpression = input.argsPresent ? `JSON.parse(${JSON.stringify(JSON.stringify(input.args))})` : "undefined";
  return `
"use strict";
const __descriptors = Object.getOwnPropertyDescriptors;
const __keys = Reflect.ownKeys;
const __getPrototypeOf = Object.getPrototypeOf;
const __isArray = Array.isArray;
const __isFinite = Number.isFinite;
const __stringify = JSON.stringify;
const __parse = JSON.parse;
const __WeakSet = WeakSet;
const __objectPrototype = Object.prototype;
const __arrayPrototype = Array.prototype;
function __encode(value) {
  const seen = new __WeakSet();
  function walk(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!__isFinite(item)) throw new TypeError("JSON numbers must be finite"); return item; }
    if (typeof item !== "object") throw new TypeError("Value is not JSON data");
    if (seen.has(item)) throw new TypeError("JSON data cannot contain cycles");
    seen.add(item);
    const isArray = __isArray(item);
    const proto = __getPrototypeOf(item);
    if (proto !== (isArray ? __arrayPrototype : __objectPrototype) && proto !== null) throw new TypeError("Unsupported JSON object");
    const descriptors = __descriptors(item);
    const keys = __keys(descriptors);
    if (keys.some(key => typeof key === "symbol")) throw new TypeError("JSON data cannot contain symbols");
    if (isArray) {
      if (keys.some(key => key !== "length" && !/^(0|[1-9]\\d*)$/.test(key))) throw new TypeError("Arrays cannot have custom properties");
      const result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Arrays must be dense data properties");
        result.push(walk(descriptor.value));
      }
      return result;
    }
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) throw new TypeError("JSON data cannot contain accessors");
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new TypeError("Prototype-sensitive keys are forbidden");
      result[key] = walk(descriptor.value);
    }
    return result;
  }
  return __stringify(walk(value));
}
function __clone(value) { return value === undefined ? undefined : __parse(__encode(value)); }
function __deepFreeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) __deepFreeze(child); Object.freeze(value); } return value; }
function __assertString(value, name, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new TypeError(name + " is invalid");
}
function __errorMessage(error) { try { return typeof error?.message === "string" ? error.message.slice(0, 2000) : String(error).slice(0, 2000); } catch { return "Task failed"; } }
let __phase;
const meta = __deepFreeze(__parse(${JSON.stringify(metaJson)}));
const args = ${argsExpression.replace("JSON.parse", "__parse")};
function phase(title) { __assertString(title, "phase title", 1, 200); __phase = title; __hostPhase(title); }
function log(message) { if (typeof message !== "string") throw new TypeError("log message must be a string"); __hostLog(message); }
function agent(prompt, options = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent prompt must contain text");
  const request = { prompt, options: __clone(options) };
  if (__phase !== undefined) request.phase = __phase;
  return __hostAgent(__encode(request), new Error().stack);
}
function workflow(reference, childArgs) {
  if (!(typeof reference === "string" && reference) && !(reference && typeof reference === "object")) throw new TypeError("workflow reference is invalid");
  const request = { reference: __clone(reference), argsPresent: arguments.length > 1, args: arguments.length > 1 ? __clone(childArgs) : null };
  if (__phase !== undefined) request.phase = __phase;
  return __hostWorkflow(__encode(request), new Error().stack);
}
async function parallel(tasks) {
  if (!Array.isArray(tasks) || tasks.length > ${input.limits.maxCombinatorItems} || Object.keys(tasks).length !== tasks.length || tasks.some(task => typeof task !== "function")) throw new TypeError("parallel expects a dense array of functions");
  return Promise.all(tasks.map((task, index) => Promise.resolve().then(task).catch(error => { __hostCombinatorError("parallel", index, __errorMessage(error), error?.stack ?? new Error().stack); return null; })));
}
async function pipeline(items, ...stages) {
  if (!Array.isArray(items) || items.length > ${input.limits.maxCombinatorItems} || Object.keys(items).length !== items.length) throw new TypeError("pipeline expects a dense items array");
  if (!stages.length || stages.some(stage => typeof stage !== "function")) throw new TypeError("pipeline expects at least one callable stage");
  return Promise.all(items.map(async (original, index) => {
    let previous = original;
    try { for (const stage of stages) previous = await stage(previous, original, index); return previous; }
    catch (error) { __hostCombinatorError("pipeline", index, __errorMessage(error), error?.stack ?? new Error().stack); return null; }
  }));
}
const budget = Object.freeze({ total: ${input.budget.total === null ? "null" : input.budget.total}, spent: () => __hostBudgetRead("spent", new Error().stack), remaining: () => __hostBudgetRead("remaining", new Error().stack) });
const __NativeDate = Date;
class __SafeDate extends __NativeDate {
  constructor(...values) {
    if (!values.length) throw new TypeError("Current time is unavailable");
    if (values.length > 1) throw new TypeError("Local-time date construction is unavailable; use Date.UTC");
    super(...values);
  }
  static now() { throw new TypeError("Current time is unavailable"); }
  static parse(value) {
    if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(value)) throw new TypeError("Only ISO UTC date parsing is available");
    return __NativeDate.parse(value);
  }
}
Object.defineProperty(globalThis, "Date", { value: Object.freeze(__SafeDate), writable: false, configurable: false });
Object.defineProperty(Math, "random", { value() { throw new TypeError("Randomness is unavailable"); }, writable: false, configurable: false });
Object.freeze(Math);
Object.freeze(JSON);
Object.freeze(Reflect);
for (const intrinsic of [
  Object.prototype, Object, Array.prototype, Array, Promise.prototype, Promise,
  WeakSet.prototype, WeakSet, Number.prototype, Number, String.prototype, String,
  Boolean.prototype, Boolean, RegExp.prototype, RegExp,
]) Object.freeze(intrinsic);
for (const name of [
  "getDate", "getDay", "getFullYear", "getHours", "getMilliseconds", "getMinutes", "getMonth", "getSeconds", "getTimezoneOffset",
  "setDate", "setFullYear", "setHours", "setMilliseconds", "setMinutes", "setMonth", "setSeconds",
  "toDateString", "toString", "toTimeString", "toLocaleString", "toLocaleDateString", "toLocaleTimeString",
]) if (name in __NativeDate.prototype) Object.defineProperty(__NativeDate.prototype, name, { value() { throw new TypeError("Local-time and locale-dependent dates are unavailable"); }, writable: false, configurable: false });
Object.freeze(__NativeDate.prototype);
globalThis.__workflowResult = (async () => {
/*__DEVSPACE_WORKFLOW_BODY__*/
${input.body}
})().then(value => ({ valueJson: __encode(value === undefined ? null : value), omittedResult: value === undefined }));
`;
}

function parseJsonHandle(context: QuickJSContext, json: string) {
  const result = context.evalCode(`JSON.parse(${JSON.stringify(json)})`);
  if (result.error) {
    const dumped = context.dump(result.error) as unknown;
    result.error.dispose();
    throw guestError(dumped);
  }
  return result.value;
}

function rejectDeferred(deferred: QuickJSDeferredPromise, error: WorkflowError): void {
  const context = deferred.context;
  const handle = context.newError(error.message);
  const code = context.newString(error.code);
  const layer = context.newString(error.layer);
  context.setProp(handle, "code", code);
  context.setProp(handle, "layer", layer);
  context.setProp(handle, "retryable", error.retryable ? context.true : context.false);
  code.dispose();
  layer.dispose();
  deferred.reject(handle);
  handle.dispose();
}

function workflowError(code: string, message: string): WorkflowError {
  return { code, message, layer: "script", retryable: false };
}

function safeError(error: unknown): WorkflowError {
  if (isWorkflowError(error)) return error;
  return workflowError("WORKFLOW_FAILED", error instanceof Error ? error.message : String(error));
}

function guestError(value: unknown, sourceLineOffset = 0, filename?: string): WorkflowError {
  if (value && typeof value === "object") {
    const error = value as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message : "Workflow script failed.";
    const knownCode = message.includes("log quota") ? "LOG_LIMIT"
      : message.includes("invocation limit") || message.includes("unresolved workflow requests") ? "AGENT_LIMIT"
      : message.includes("usage is unavailable") ? "USAGE_UNAVAILABLE"
      : message.includes("interrupted") ? "SCRIPT_CPU_LIMIT"
      : undefined;
    const location = errorLocation(typeof error.stack === "string" ? error.stack : "", sourceLineOffset, filename);
    return {
      code: typeof error.code === "string" ? error.code : knownCode ?? "WORKFLOW_FAILED",
      message,
      layer: "script",
      retryable: false,
      ...(location ? { location } : {}),
    };
  }
  return workflowError("WORKFLOW_FAILED", String(value));
}

function errorLocation(stack: string, sourceLineOffset: number, filename?: string): { line: number; column: number } | undefined {
  for (const match of stack.matchAll(/(?:^|\n)\s*at\s+(?:.*?\s+\()?([^()\s]+):(\d+):(\d+)\)?/g)) {
    if (filename && match[1] !== filename && !match[1]?.endsWith(`/${filename}`)) continue;
    const line = Number(match[2]) - sourceLineOffset;
    const column = Number(match[3]);
    if (line > 0 && Number.isSafeInteger(column) && column > 0) return { line, column };
  }
  return undefined;
}

function isWorkflowError(value: unknown): value is WorkflowError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<WorkflowError>;
  return typeof error.code === "string" && typeof error.message === "string"
    && typeof error.layer === "string" && typeof error.retryable === "boolean";
}

function isBudget(value: unknown): value is WorkflowBudgetSnapshot {
  if (!value || typeof value !== "object") return false;
  const budget = value as Partial<WorkflowBudgetSnapshot>;
  return (budget.total === null || typeof budget.total === "number")
    && typeof budget.knownSpent === "number" && typeof budget.complete === "boolean";
}

function sameLocation(
  left: { line: number; column: number },
  right: { line: number; column: number } | undefined,
): boolean {
  return right !== undefined && left.line === right.line && left.column === right.column;
}
