import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngineError } from "./workflow-api.js";
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
  signal?: AbortSignal;
}

type SandboxMethod = "agent" | "workflow" | "phase" | "log";

interface SandboxStartMessage {
  type: "start";
  source: string;
  filename: string;
  args: JsonValue | undefined;
  budget: {
    total: number | null;
    spent: number;
    remaining: number;
  };
}

interface SandboxCallMessage {
  type: "call";
  id: number;
  method: Extract<SandboxMethod, "agent" | "workflow">;
  args: unknown[];
}

interface SandboxNotifyMessage {
  type: "notify";
  method: Extract<SandboxMethod, "phase" | "log">;
  args: unknown[];
}

interface SandboxResultMessage {
  type: "result";
  value: unknown;
}

interface SandboxErrorMessage {
  type: "error";
  error: SerializedError;
}

interface SandboxCallResultMessage {
  type: "call_result";
  id: number;
  value?: unknown;
  error?: SerializedError;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  kind?: string;
}

type MessageFromChild =
  | SandboxCallMessage
  | SandboxNotifyMessage
  | SandboxResultMessage
  | SandboxErrorMessage;

/**
 * Execute a workflow in a disposable child process. The child owns the vm
 * context and can be terminated even when model-authored JavaScript blocks its
 * event loop with synchronous code.
 */
export async function runWorkflowSandbox(
  options: RunWorkflowSandboxOptions,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;
  const child = spawnSandboxChild();

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;

    const finish = (outcome: { value: unknown } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };

    const terminate = (error: Error): void => {
      finish({ error });
    };

    const onAbort = (): void => {
      terminate(new WorkflowEngineError("cancelled", "Workflow cancelled"));
    };

    const timer = setTimeout(() => {
      terminate(new Error(`Workflow script exceeded host timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("message", (message: MessageFromChild) => {
      void handleChildMessage(child, options.api, message, finish);
    });
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code, signal) => {
      if (settled) return;
      finish({
        error: new Error(
          `Workflow sandbox exited before returning a result (code=${String(code)}, signal=${String(signal)})`,
        ),
      });
    });

    const start: SandboxStartMessage = {
      type: "start",
      source: options.parsed.source,
      filename: options.parsed.filename,
      args: options.api.args,
      budget: {
        total: options.api.budget.total,
        spent: options.api.budget.spent(),
        remaining: options.api.budget.remaining(),
      },
    };
    safeSend(child, start);
  });
}

async function handleChildMessage(
  child: ChildProcess,
  api: WorkflowSandboxApi,
  message: MessageFromChild,
  finish: (outcome: { value: unknown } | { error: unknown }) => void,
): Promise<void> {
  switch (message.type) {
    case "result":
      finish({ value: message.value });
      return;
    case "error":
      finish({ error: deserializeError(message.error) });
      return;
    case "notify":
      try {
        if (message.method === "phase") {
          api.phase(message.args[0] as string);
        } else {
          api.log(...message.args);
        }
      } catch (error) {
        if (!child.killed) child.kill("SIGKILL");
        finish({ error });
      }
      return;
    case "call": {
      const reply: SandboxCallResultMessage = {
        type: "call_result",
        id: message.id,
      };
      try {
        reply.value = message.method === "agent"
          ? await api.agent(message.args[0] as string, message.args[1] as never)
          : await api.workflow(message.args[0] as never, message.args[1] as never);
      } catch (error) {
        reply.error = serializeError(error);
      }
      safeSend(child, reply);
      return;
    }
  }
}

function spawnSandboxChild(): ChildProcess {
  const selfUrl = import.meta.url;
  const childUrl = selfUrl.replace(
    /workflow-sandbox\.(ts|js)$/,
    "workflow-sandbox-child.$1",
  );
  if (childUrl === selfUrl) {
    throw new Error(`Unable to resolve workflow sandbox child entry from ${selfUrl}`);
  }
  const childEntry = fileURLToPath(childUrl);
  return fork(childEntry, [], {
    execArgv: process.execArgv,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });
}

function safeSend(child: ChildProcess, message: object): void {
  if (!child.connected) return;
  try {
    child.send(message, () => {
      // The sandbox may close while an agent call is completing.
    });
  } catch {
    // The child is already being torn down.
  }
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const kind = "kind" in error && typeof error.kind === "string" ? error.kind : undefined;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    kind,
  };
}

function deserializeError(input: SerializedError): Error {
  const error = input.name === "WorkflowDeterminismError"
    ? new WorkflowDeterminismError(input.message)
    : input.name === "WorkflowEngineError" && input.kind
      ? new WorkflowEngineError(
          input.kind as ConstructorParameters<typeof WorkflowEngineError>[0],
          input.message,
        )
      : new Error(input.message);
  error.name = input.name;
  if (input.stack) error.stack = input.stack;
  if (input.kind) Object.assign(error, { kind: input.kind });
  return error;
}
