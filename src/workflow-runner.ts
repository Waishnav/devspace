import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowError, type WorkflowAgentOptions } from "./workflow-types.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import { isJsonString, isJsonNumber, isBigintValue, isSymbolValue, isFunctionValue, isJsonObject } from "./json-value.js";
import type { JsonObject, JsonValue } from "./json-value.js";

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
  onAgent(prompt: string, options: WorkflowAgentOptions): Promise<JsonValue> | unknown;
  onWorkflow?(name: string, args: JsonValue): Promise<JsonValue> | unknown;
  onEvent?(type: string, data: JsonValue): Promise<void> | void;
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

  if (!isJsonString(input.source)) {
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
  let resultReceived = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });

  return await new Promise<JsonValue>((resolve, reject) => {
    const finish = (error?: JsonValue, value?: JsonValue) => {
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
      // SAFETY: Boundary value already validated or constructed to match this type.
      else resolve(value as JsonValue);
    };

    const fatal = (error: JsonValue) => finish(asWorkflowError(error));
    const abort = () => fatal(cancelled(input.signal?.reason));

    const timer = setTimeout(() => {
      fatal(new WorkflowError("WORKFLOW_TIMEOUT", `Workflow exceeded ${limits.timeoutMs}ms.`));
    }, limits.timeoutMs);

    timer.unref();
    input.signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => fatal(new WorkflowError("WORKFLOW_RUNNER_FAILED", error.message)));
    // The child sends its result and then disconnects; `exit` can be observed before the
    // message is delivered, so report the exit only once the IPC channel has drained.
    child.once("exit", (code, signal) => {
      const report = () => {
        if (settled || resultReceived) return;
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        fatal(new WorkflowError(
          "WORKFLOW_RUNNER_EXITED",
          `Workflow runner exited before returning a result (${signal ?? code ?? "unknown"})${detail}`,
        ));
      };

      if (!child.connected) return void setImmediate(report);
      const grace = setTimeout(report, 1_000);
      grace.unref();
      child.once("disconnect", () => { clearTimeout(grace); setImmediate(report); });
    });
    child.on("message", (message: JsonValue) => {
      if (settled || !isRecord(message) || !isJsonString(message.type)) return;

      if (message.type === "host-call") {
        void handleHostCall(unsafeNarrow<HostCallMessage>(message)).catch(fatal);

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

          // SAFETY: Boundary value already validated or constructed to match this type.
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

        resultReceived = true;
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
          if (!isJsonString(message.prompt) || message.prompt.length === 0) {
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

          if (!isJsonString(message.name) || message.name.trim().length === 0 || message.name.length > 128) {
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

export function validateJson(value: JsonValue, label: string, maxBytes: number): JsonValue {
  let encoded: string | undefined;

  try {
    encoded = JSON.stringify(value, (_key, current: JsonValue) => {
      if (isJsonNumber(current) && !Number.isFinite(current)) throw new TypeError("non-finite number");

      if (isBigintValue(current) || isFunctionValue(current) || isSymbolValue(current) || current === undefined) {
        throw new TypeError(`unsupported ${typeof current}`);
      }

      if (current && isJsonObject(current) && !Array.isArray(current)) {
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

  // SAFETY: Boundary value already validated or constructed to match this type.
  return JSON.parse(encoded) as JsonValue;
}

function validateAgentOptions(value: JsonValue, maxBytes: number): WorkflowAgentOptions {
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
    && (!isJsonString(options.workspace) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.workspace))) {
    throw new WorkflowError("WORKFLOW_INVALID_AGENT_CALL", "agent options.workspace must be a logical key, not a path.");
  }

  return unsafeNarrow<WorkflowAgentOptions>(options);
}

function resolveLimits(input: Partial<WorkflowRunnerLimits> | undefined): WorkflowRunnerLimits {
  const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...input };

  // SAFETY: Boundary value already validated or constructed to match this type.
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

function sendHostError(child: ChildProcess, id: number, error: JsonValue): void {
  const workflowError = asWorkflowError(error);
  send(child, {
    type: "host-result",
    id,
    ok: false,
    fatal: isFatalCode(workflowError.code),
    error: { code: workflowError.code, message: workflowError.message, retryable: workflowError.retryable },
  });
}

function send(child: ChildProcess, message: JsonValue): void {
  if (!child.connected) return;

  try {
    // SAFETY: Boundary value already validated or constructed to match this type.
    child.send(message as never, () => undefined);
  } catch {
    // The runner's exit/disconnect path reports the failure.
  }
}

function decodeError(value: JsonValue, fallbackCode: string): WorkflowError {
  if (!isRecord(value)) return new WorkflowError(fallbackCode, "Workflow failed.");

  return new WorkflowError(
    isJsonString(value.code) ? value.code : fallbackCode,
    isJsonString(value.message) ? value.message : "Workflow failed.",
    value.retryable === true,
  );
}

function asWorkflowError(error: JsonValue): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const value = error as { code?: unknown; retryable?: unknown } | undefined;

  return new WorkflowError(
    isJsonString(value?.code) ? value.code : "WORKFLOW_FAILED",
    errorMessage(error),
    value?.retryable === true,
  );
}

function cancelled(reason: JsonValue): WorkflowError {
  if (reason instanceof WorkflowError) return reason;
  const value = reason as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;

  return new WorkflowError(
    isJsonString(value?.code) ? value.code : "WORKFLOW_CANCELLED",
    isJsonString(value?.message) ? value.message : "Workflow was cancelled.",
    value?.retryable === true,
  );
}

function validString(value: JsonValue, maximum: number): value is string {
  return isJsonString(value) && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && isJsonObject(value) && !Array.isArray(value);
}

function errorMessage(error: JsonValue): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatalCode(code: string): boolean {
  return code.includes("LIMIT")
    || code.includes("INTERNAL")
    || code.includes("PROTOCOL")
    || code === "WORKFLOW_TIMEOUT"
    || code === "WORKFLOW_CANCELLED";
}
