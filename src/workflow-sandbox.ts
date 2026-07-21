import vm from "node:vm";
import type { ParsedWorkflowScript } from "./workflow-script.js";
import type { JsonValue } from "./json-types.js";
import type {
  WorkflowAgent,
  WorkflowBudget,
  WorkflowMeta,
  WorkflowNested,
  WorkflowParallel,
  WorkflowPipeline,
} from "./workflow-types.js";

export class WorkflowDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDeterminismError";
  }
}

export interface WorkflowSandboxApi {
  agent: WorkflowAgent;
  parallel: WorkflowParallel;
  pipeline: WorkflowPipeline;
  phase: (title: string) => void;
  log: (...args: unknown[]) => unknown;
  args: JsonValue | undefined;
  budget: WorkflowBudget;
  workflow: WorkflowNested;
  /** Host bookkeeping only; script binds its own `const meta`. */
  meta: WorkflowMeta;
}

export interface RunWorkflowSandboxOptions {
  parsed: ParsedWorkflowScript;
  api: WorkflowSandboxApi;
  /** Host wall-clock max for the whole script (ms). Default 6h. */
  timeoutMs?: number;
}

/**
 * Execute a compiled workflow script in a restricted node:vm context.
 * Not a hostile multi-tenant security boundary — determinism + capability reduction.
 */
export async function runWorkflowSandbox(
  options: RunWorkflowSandboxOptions,
): Promise<unknown> {
  const { parsed, api } = options;
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;

  const consoleProxy = {
    log: (...args: unknown[]) => {
      api.log(args.map(stringifyConsoleArg).join(" "));
    },
    warn: (...args: unknown[]) => {
      api.log(args.map(stringifyConsoleArg).join(" "));
    },
    error: (...args: unknown[]) => {
      api.log(args.map(stringifyConsoleArg).join(" "));
    },
    info: (...args: unknown[]) => {
      api.log(args.map(stringifyConsoleArg).join(" "));
    },
    debug: (...args: unknown[]) => {
      api.log(args.map(stringifyConsoleArg).join(" "));
    },
  };

  // Script params: host APIs only. `meta`/`console` are not params (meta is script-local;
  // console lives on sandbox globals so console.log works).
  const sandboxApi = {
    agent: api.agent,
    parallel: api.parallel,
    pipeline: api.pipeline,
    phase: api.phase,
    log: api.log,
    args: api.args,
    budget: api.budget,
    workflow: api.workflow,
  };

  const context = vm.createContext(createSandboxGlobals(consoleProxy));
  const factory = parsed.script.runInContext(context, {
    timeout: 5_000,
    displayErrors: true,
  }) as (api: typeof sandboxApi) => Promise<unknown>;

  if (typeof factory !== "function") {
    throw new Error("Workflow script did not compile to a function");
  }

  const result = await withTimeout(
    Promise.resolve().then(() => factory(sandboxApi)),
    timeoutMs,
  );
  // Context objects keep the sandbox realm's prototypes; rehydrate for host use.
  return rehydrateHostValue(result);
}

/** Copy a sandbox value into the host realm (plain objects / arrays / primitives). */
export function rehydrateHostValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return value;
  if (Array.isArray(value)) {
    return Array.from(value as unknown[], (item) => rehydrateHostValue(item));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = rehydrateHostValue(entry);
  }
  return out;
}

function createSandboxGlobals(
  consoleProxy: Record<string, (...args: unknown[]) => void>,
): Record<string, unknown> {
  return {
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    WeakSet,
    JSON,
    Math: createBannedMath(),
    Date: createBannedDate(),
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URIError,
    EvalError,
    Promise,
    Symbol,
    Proxy,
    Reflect,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    undefined,
    NaN,
    Infinity,
    console: consoleProxy,
    // Explicitly absent: require, process, fetch, Buffer, setTimeout, setInterval, ...
  };
}

function createBannedDate(): typeof Date {
  const RealDate = Date;

  function DateShim(this: unknown, ...args: unknown[]): string | Date {
    if (new.target) {
      if (args.length === 0) {
        throw new WorkflowDeterminismError(
          "new Date() without arguments is banned in workflow scripts (pass an ISO string)",
        );
      }
      return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
    }
    throw new WorkflowDeterminismError("Date() is banned in workflow scripts");
  }

  DateShim.now = function bannedNow(): number {
    throw new WorkflowDeterminismError("Date.now() is banned in workflow scripts");
  };
  DateShim.parse = RealDate.parse.bind(RealDate);
  DateShim.UTC = RealDate.UTC.bind(RealDate);
  Object.setPrototypeOf(DateShim, RealDate);
  DateShim.prototype = RealDate.prototype;
  return DateShim as unknown as typeof Date;
}

function createBannedMath(): Math {
  return new Proxy(Math, {
    get(target, prop, receiver) {
      if (prop === "random") {
        return () => {
          throw new WorkflowDeterminismError("Math.random() is banned in workflow scripts");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function stringifyConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Workflow script exceeded host timeout (${ms}ms)`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
