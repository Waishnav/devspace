import { randomUUID } from "node:crypto";
import type { CodemodeResult } from "@earendil-works/pi-codemode";
import { ProcessOwner, type ProcessSessionManager } from "./process-sessions.js";
import type { CodeModeRegistry } from "./code-mode-registry.js";

export const MAX_CODE_MODE_YIELD_MS = 12_000;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_SCRIPT_MS = 5 * 60_000;
const MAX_CALLS = 32;
const MAX_CONCURRENT_CALLS = 4;

// Each running script holds a worker with its own 256 MiB heap allowance.
export const MAX_RUNNING_EXECUTIONS = 4;
const COMPLETED_TTL_MS = 5 * 60_000;

type Status = "running" | "completed" | "failed" | "cancelled";

interface Execution {
  id: string;
  workspaceId: string;
  status: Status;
  controller: AbortController;
  processes: ProcessOwner;
  done: Promise<void>;
  result?: CodemodeResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  cleanupTimer?: NodeJS.Timeout;
}

export interface ExecutionSnapshot {
  execution_id: string;
  running: boolean;
  status: Status;
  result?: unknown;
  output?: string[];
  error?: string;
  calls?: CodemodeResult["calls"];
}

/** Runs at most `max` tasks at once; a finishing task hands its slot straight to the next waiter. */
export function concurrencyLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];

  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiters.push(resolve));

    try {
      return await task();
    } finally {
      const next = waiters.shift();

      if (next) next();
      else active--;
    }
  };
}

function yieldWindow(ms: number | undefined, fallback: number): number {
  return ms === undefined ? fallback : Math.min(ms, MAX_CODE_MODE_YIELD_MS);
}

export class CodeModeExecutions {
  private readonly executions = new Map<string, Execution>();
  private closed = false;

  constructor(
    private readonly registry: CodeModeRegistry,
    private readonly processes: ProcessSessionManager,
  ) {}

  async start(workspaceId: string, code: string, yieldTimeMs?: number): Promise<ExecutionSnapshot> {
    if (this.closed) throw new Error("DevSpace is shutting down; Code Mode scripts can no longer start.");
    const running = [...this.executions.values()].filter((execution) => execution.status === "running").length;

    if (running >= MAX_RUNNING_EXECUTIONS) {
      throw new Error(`DevSpace is already running ${MAX_RUNNING_EXECUTIONS} Code Mode scripts. Wait for one with poll_execution or stop one with cancel_execution, then retry.`);
    }

    const id = randomUUID();

    const execution: Execution = {
      id,
      workspaceId,
      status: "running",
      controller: new AbortController(),
      processes: new ProcessOwner(),
      done: Promise.resolve(),
      startedAt: performance.now(),
    };

    this.executions.set(id, execution);
    execution.done = this.run(execution, code);
    await this.wait(execution, yieldWindow(yieldTimeMs, DEFAULT_YIELD_MS));

    return this.snapshot(execution);
  }

  async poll(workspaceId: string, id: string, yieldTimeMs?: number): Promise<ExecutionSnapshot> {
    const execution = this.get(workspaceId, id);
    await this.wait(execution, yieldWindow(yieldTimeMs, DEFAULT_POLL_MS));

    return this.snapshot(execution);
  }

  /** Resolves once the script has stopped and every command it started has exited. */
  async cancel(workspaceId: string, id: string): Promise<ExecutionSnapshot> {
    const execution = this.get(workspaceId, id);

    if (execution.status === "running") await this.stop(execution, "Execution cancelled by user.");

    return this.snapshot(execution);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const executions = [...this.executions.values()];

    for (const execution of executions) {
      if (execution.cleanupTimer) clearTimeout(execution.cleanupTimer);
    }

    await Promise.allSettled(executions
      .filter((execution) => execution.status === "running")
      .map((execution) => this.stop(execution, "DevSpace shutting down.")));
    this.executions.clear();
  }

  private async stop(execution: Execution, reason: string): Promise<void> {
    execution.controller.abort(new Error(reason));
    const [, terminated] = await Promise.allSettled([execution.done, execution.processes.terminate()]);

    if (terminated.status === "fulfilled") recordUnconfirmedExits(execution, terminated.value);
  }

  private get(workspaceId: string, id: string): Execution {
    const execution = this.executions.get(id);

    if (!execution || execution.workspaceId !== workspaceId) {
      throw new Error("Code execution does not exist in this workspace.");
    }

    return execution;
  }

  private snapshot(execution: Execution): ExecutionSnapshot {
    const result = execution.result;

    return {
      execution_id: execution.id,
      running: execution.status === "running",
      status: execution.status,
      ...(result?.ok ? { result: result.value } : {}),
      ...(result ? {
        output: result.output.filter((item) => item.type === "text").map((item) => item.text),
        calls: result.calls,
      } : {}),
      ...(execution.error ? { error: execution.error } : {}),
    };
  }

  private async wait(execution: Execution, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        execution.done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(execution: Execution, code: string): Promise<void> {
    try {
      // The worker and WASM runtime are loaded only when the experimental mode runs a script.
      const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
      let calls = 0;
      const limit = concurrencyLimiter(MAX_CONCURRENT_CALLS);

      const tools = this.registry.tools(execution.workspaceId)
        .map((tool) => ({
          ...tool,
          execute: async (args: unknown, context: Parameters<typeof tool.execute>[1]) => {
            if (++calls > MAX_CALLS) throw new Error(`Code Mode limit exceeded: ${MAX_CALLS} tool calls.`);

            return limit(async () => {
              if (execution.controller.signal.aborted) throw new Error("Code execution cancelled.");

              return this.processes.runOwned(execution.processes, () => tool.execute(args, context));
            });
          },
        }));

      const sandbox = new CodemodeSandbox({
        tools,
        timeoutMs: MAX_SCRIPT_MS,
        memoryLimitBytes: 256 * 1024 * 1024,
      });

      try {
        execution.result = await sandbox.execute(code, { signal: execution.controller.signal });
        execution.status = execution.controller.signal.aborted ? "cancelled" : execution.result.ok ? "completed" : "failed";

        if (!execution.result.ok) execution.error = execution.result.error.message;
      } finally {
        await sandbox.close();
      }
    } catch (error) {
      execution.error = error instanceof Error ? error.message : String(error);
      execution.status = execution.controller.signal.aborted ? "cancelled" : "failed";
    } finally {
      if (execution.status !== "completed") recordUnconfirmedExits(execution, await execution.processes.terminate());
      execution.finishedAt = performance.now();
      execution.cleanupTimer = setTimeout(() => this.executions.delete(execution.id), COMPLETED_TTL_MS);
      execution.cleanupTimer.unref();
    }
  }
}

// Surface incomplete termination instead of reporting a clean stop.
function recordUnconfirmedExits(execution: Execution, unconfirmed: number): void {
  if (unconfirmed === 0) return;
  const note = `${unconfirmed} command${unconfirmed === 1 ? " was" : "s were"} killed but did not close output; a detached descendant may still be running.`;

  if (!execution.error?.includes(note)) execution.error = execution.error ? `${execution.error} ${note}` : note;
}
