import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowError, type WorkflowAgentOptions } from "./workflow-types.js";
import { parseWorkflowScript } from "./workflow-script.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowRunnerLimits {
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxSourceBytes: number;
  maxArgsBytes: number;
  maxResultBytes: number;
  maxLogBytes: number;
  maxLogEntries: number;
  maxOutstanding: number;
}

export interface RunWorkflowScriptInput {
  source: string;
  args?: unknown;
  limits?: Partial<WorkflowRunnerLimits>;
  signal?: AbortSignal;
  /** Internal nesting marker. A nested runner must pass depth: 1. */
  depth?: number;
  onAgent(prompt: string, options: WorkflowAgentOptions): Promise<unknown> | unknown;
  onWorkflow?(name: string, args: unknown): Promise<unknown> | unknown;
  onEvent?(type: string, data: unknown): Promise<void> | void;
}

export const DEFAULT_WORKFLOW_LIMITS: Readonly<WorkflowRunnerLimits> = Object.freeze({
  timeoutMs: 15 * 60_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxSourceBytes: 64 * 1024,
  maxArgsBytes: 128 * 1024,
  maxResultBytes: 256 * 1024,
  maxLogBytes: 64 * 1024,
  maxLogEntries: 1_024,
  maxOutstanding: 256,
});

const HARD_LIMITS: WorkflowRunnerLimits = {
  timeoutMs: 24 * 60 * 60_000,
  memoryBytes: 512 * 1024 * 1024,
  stackBytes: 16 * 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
  maxArgsBytes: 16 * 1024 * 1024,
  maxResultBytes: 64 * 1024 * 1024,
  maxLogBytes: 4 * 1024 * 1024,
  maxLogEntries: 100_000,
  maxOutstanding: 4_096,
};

interface RunnerErrorPayload { code: string; message: string; retryable?: boolean }
interface HostCallMessage {
  type: "host-call";
  id: number;
  kind: "agent" | "workflow";
  prompt?: unknown;
  options?: unknown;
  name?: unknown;
  args?: unknown;
}

export async function runWorkflowScript(input: RunWorkflowScriptInput): Promise<JsonValue> {
  const limits = resolveLimits(input.limits);
  if (typeof input.source !== "string") {
    throw new WorkflowError("WORKFLOW_INVALID_SOURCE", "Workflow source must be a string.");
  }
  validateBytes(input.source, "Workflow source", limits.maxSourceBytes);
  const parsed = parseWorkflowScript(input.source);
  const args = validateJson(input.args ?? null, "Workflow arguments", limits.maxArgsBytes);
  if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 1)) {
    throw new WorkflowError("WORKFLOW_NESTING_LIMIT", "Workflows may be nested at most one level.");
  }
  if (input.signal?.aborted) throw cancelled(input.signal.reason);

  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const childPath = fileURLToPath(new URL(`./workflow-runner-child.${extension}`, import.meta.url));
  const child = fork(childPath, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
    env: {},
  });

  let settled = false;
  let outstanding = 0;
  let eventBytes = 0;
  let eventEntries = 0;
  let stderr = "";
  let eventChain = Promise.resolve();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });

  return await new Promise<JsonValue>((resolve, reject) => {
    const finish = (error?: unknown, value?: JsonValue) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      if (child.connected) {
        try { child.disconnect(); } catch { /* The child is already closing. */ }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value as JsonValue);
    };
    const fatal = (error: unknown) => finish(asWorkflowError(error));
    const abort = () => fatal(cancelled(input.signal?.reason));
    const timer = setTimeout(() => {
      fatal(new WorkflowError("WORKFLOW_TIMEOUT", `Workflow exceeded ${limits.timeoutMs}ms.`));
    }, limits.timeoutMs);
    timer.unref();
    input.signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => fatal(new WorkflowError("WORKFLOW_RUNNER_FAILED", error.message)));
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      fatal(new WorkflowError(
        "WORKFLOW_RUNNER_EXITED",
        `Workflow runner exited before returning a result (${signal ?? code ?? "unknown"})${detail}`,
      ));
    });
    child.on("message", (message: unknown) => {
      if (settled || !isRecord(message) || typeof message.type !== "string") return;
      if (message.type === "host-call") {
        void handleHostCall(message as unknown as HostCallMessage).catch(fatal);
        return;
      }
      if (message.type === "event") {
        if (message.eventType !== "log"
          && message.eventType !== "phase_started"
          && message.eventType !== "phase_completed"
          && message.eventType !== "phase_failed") {
          fatal(new WorkflowError("WORKFLOW_PROTOCOL_ERROR", "Workflow runner sent an invalid event."));
          return;
        }
        try {
          const data = validateJson(message.data, "Workflow event", limits.maxArgsBytes);
          eventEntries += 1;
          eventBytes += Buffer.byteLength(JSON.stringify(data), "utf8") + message.eventType.length;
          if (eventEntries > limits.maxLogEntries || eventBytes > limits.maxLogBytes) {
            throw new WorkflowError("WORKFLOW_LOG_LIMIT", "Workflow events exceed their configured limit.");
          }
          eventChain = eventChain.then(() => input.onEvent?.(message.eventType as string, data));
          eventChain.catch(fatal);
        } catch (error) {
          fatal(error);
        }
        return;
      }
      if (message.type === "fatal" || message.type === "error") {
        fatal(decodeError(message.error, message.type === "fatal" ? "WORKFLOW_LIMIT" : "WORKFLOW_FAILED"));
        return;
      }
      if (message.type === "result") {
        let result: JsonValue;
        try {
          result = validateJson(message.value, "Workflow result", limits.maxResultBytes);
        } catch (error) {
          fatal(error);
          return;
        }
        void eventChain.then(() => finish(undefined, result), fatal);
      }
    });

    const handleHostCall = async (message: HostCallMessage): Promise<void> => {
      if (!Number.isSafeInteger(message.id) || message.id < 1 || outstanding >= limits.maxOutstanding) {
        throw new WorkflowError("WORKFLOW_OUTSTANDING_LIMIT", "Workflow has too many outstanding host calls.");
      }
      outstanding += 1;
      try {
        let value: JsonValue;
        if (message.kind === "agent") {
          if (typeof message.prompt !== "string" || message.prompt.length === 0) {
            return sendHostError(child, message.id, new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent prompt must be a non-empty string."));
          }
          validateBytes(message.prompt, "Agent prompt", limits.maxArgsBytes);
          const options = validateAgentOptions(message.options, limits.maxArgsBytes);
          value = validateJson(
            await input.onAgent(message.prompt, options),
            "Agent result",
            limits.maxResultBytes,
          );
        } else if (message.kind === "workflow") {
          if ((input.depth ?? 0) >= 1) {
            return sendHostError(child, message.id, new WorkflowError("WORKFLOW_NESTING_LIMIT", "Workflows may be nested at most one level."));
          }
          if (!input.onWorkflow) {
            return sendHostError(child, message.id, new WorkflowError("WORKFLOW_UNAVAILABLE", "Nested workflows are unavailable."));
          }
          if (typeof message.name !== "string" || message.name.trim().length === 0 || message.name.length > 128) {
            return sendHostError(child, message.id, new WorkflowError("WORKFLOW_INVALID_CALL", "workflow name must be a non-empty string."));
          }
          const nestedArgs = validateJson(message.args ?? null, "Nested workflow arguments", limits.maxArgsBytes);
          value = validateJson(
            await input.onWorkflow(message.name, nestedArgs),
            "Nested workflow result",
            limits.maxResultBytes,
          );
        } else {
          throw new WorkflowError("WORKFLOW_PROTOCOL_ERROR", "Workflow runner requested an unknown host call.");
        }
        send(child, { type: "host-result", id: message.id, ok: true, value });
      } catch (error) {
        sendHostError(child, message.id, error);
      } finally {
        outstanding -= 1;
      }
    };

    send(child, {
      type: "run",
      source: parsed.body,
      args,
      meta: parsed.meta,
      limits,
    });
  });
}

export function validateJson(value: unknown, label: string, maxBytes: number): JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "number" && !Number.isFinite(current)) throw new TypeError("non-finite number");
      if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol" || current === undefined) {
        throw new TypeError(`unsupported ${typeof current}`);
      }
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-plain object");
      }
      return current;
    });
  } catch (error) {
    throw new WorkflowError("WORKFLOW_INVALID_JSON", `${label} must be JSON: ${errorMessage(error)}`);
  }
  if (encoded === undefined) throw new WorkflowError("WORKFLOW_INVALID_JSON", `${label} must be JSON.`);
  validateBytes(encoded, label, maxBytes);
  return JSON.parse(encoded) as JsonValue;
}

function validateAgentOptions(value: unknown, maxBytes: number): WorkflowAgentOptions {
  const options = validateJson(value, "Agent options", maxBytes);
  if (!isRecord(options)) throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options must be an object.");
  const allowed = new Set(["target", "model", "effort", "schema", "label", "phase", "writeMode", "isolation", "workspace"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", `Unknown agent option: ${key}`);
  }
  if (!validString(options.target, 128)) {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.target must be a non-empty string.");
  }
  for (const key of ["model", "effort", "label", "phase"] as const) {
    if (options[key] !== undefined && !validString(options[key], 256)) {
      throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", `agent options.${key} must be a non-empty string.`);
    }
  }
  if (options.schema !== undefined && !isRecord(options.schema)) {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.schema must be an object.");
  }
  if (options.writeMode !== undefined && options.writeMode !== "read_only" && options.writeMode !== "allowed") {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.writeMode must be read_only or allowed.");
  }
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.isolation must be worktree.");
  }
  if (options.workspace !== undefined
    && (typeof options.workspace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.workspace))) {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.workspace must be a logical key, not a path.");
  }
  return options as unknown as WorkflowAgentOptions;
}

function resolveLimits(input: Partial<WorkflowRunnerLimits> | undefined): WorkflowRunnerLimits {
  const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_WORKFLOW_LIMITS) as Array<keyof WorkflowRunnerLimits>) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
      throw new WorkflowError("WORKFLOW_INVALID_LIMIT", `${key} must be an integer between 1 and ${HARD_LIMITS[key]}.`);
    }
  }
  return limits;
}

function validateBytes(value: string, label: string, limit: number): void {
  if (Buffer.byteLength(value, "utf8") > limit) {
    throw new WorkflowError("WORKFLOW_SIZE_LIMIT", `${label} exceeds the ${limit}-byte limit.`);
  }
}

function sendHostError(child: ChildProcess, id: number, error: unknown): void {
  const workflowError = asWorkflowError(error);
  send(child, {
    type: "host-result",
    id,
    ok: false,
    fatal: isFatalCode(workflowError.code),
    error: { code: workflowError.code, message: workflowError.message, retryable: workflowError.retryable },
  });
}

function send(child: ChildProcess, message: unknown): void {
  if (!child.connected) return;
  try {
    child.send(message as never, () => undefined);
  } catch {
    // The runner's exit/disconnect path reports the failure.
  }
}

function decodeError(value: unknown, fallbackCode: string): WorkflowError {
  if (!isRecord(value)) return new WorkflowError(fallbackCode, "Workflow failed.");
  return new WorkflowError(
    typeof value.code === "string" ? value.code : fallbackCode,
    typeof value.message === "string" ? value.message : "Workflow failed.",
    value.retryable === true,
  );
}

function asWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const value = error as { code?: unknown; retryable?: unknown } | undefined;
  return new WorkflowError(
    typeof value?.code === "string" ? value.code : "WORKFLOW_FAILED",
    errorMessage(error),
    value?.retryable === true,
  );
}

function cancelled(reason: unknown): WorkflowError {
  if (reason instanceof WorkflowError) return reason;
  const value = reason as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
  return new WorkflowError(
    typeof value?.code === "string" ? value.code : "WORKFLOW_CANCELLED",
    typeof value?.message === "string" ? value.message : "Workflow was cancelled.",
    value?.retryable === true,
  );
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatalCode(code: string): boolean {
  return code.includes("LIMIT")
    || code.includes("INTERNAL")
    || code.includes("PROTOCOL")
    || code === "WORKFLOW_TIMEOUT"
    || code === "WORKFLOW_CANCELLED";
}
