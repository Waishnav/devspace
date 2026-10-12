import { randomUUID } from "node:crypto";
import type { CodemodeResult } from "@earendil-works/pi-codemode";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { CodeModeRegistry } from "./code-mode-registry.js";

export const MAX_CODE_MODE_YIELD_MS = 12_000;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_SCRIPT_MS = 5 * 60_000;
const MAX_CALLS = 32;
const MAX_CONCURRENT_CALLS = 4;
const COMPLETED_TTL_MS = 5 * 60_000;

type Status = "running" | "completed" | "failed" | "cancelled";

interface Execution {
  id: string;
  workspaceId: string;
  status: Status;
  controller: AbortController;
  done: Promise<void>;
  result?: CodemodeResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  processSessionIds: Set<number>;
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

function yieldWindow(ms: number | undefined, fallback: number): number {
  return ms === undefined ? fallback : Math.min(ms, MAX_CODE_MODE_YIELD_MS);
}

export class CodeModeExecutions {
  private readonly executions = new Map<string, Execution>();

  constructor(
    private readonly registry: CodeModeRegistry,
    private readonly processes: ProcessSessionManager,
  ) {}

  async start(workspaceId: string, code: string, yieldTimeMs?: number): Promise<ExecutionSnapshot> {
    const id = randomUUID();
    const execution: Execution = {
      id,
      workspaceId,
      status: "running",
      controller: new AbortController(),
      done: Promise.resolve(),
      startedAt: performance.now(),
      processSessionIds: new Set(),
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

  cancel(workspaceId: string, id: string): ExecutionSnapshot {
    const execution = this.get(workspaceId, id);
    if (execution.status === "running") {
      execution.controller.abort(new Error("Execution cancelled by user."));
      this.terminateProcesses(execution);
    }
    return this.snapshot(execution);
  }

  async shutdown(): Promise<void> {
    for (const execution of this.executions.values()) {
      if (execution.cleanupTimer) clearTimeout(execution.cleanupTimer);
      if (execution.status === "running") {
        execution.controller.abort(new Error("DevSpace shutting down."));
        this.terminateProcesses(execution);
      }
    }
    await Promise.allSettled([...this.executions.values()].map((execution) => execution.done));
    this.executions.clear();
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

  private terminateProcesses(execution: Execution): void {
    for (const id of execution.processSessionIds) {
      try {
        this.processes.terminate(execution.workspaceId, id);
      } catch {
        // A process might have finished and been reaped already.
      }
    }
  }

  private async run(execution: Execution, code: string): Promise<void> {
    try {
      // The worker and WASM runtime are loaded only when the experimental mode runs a script.
      const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
      let calls = 0;
      let active = 0;
      const waiters: Array<() => void> = [];
      const tools = this.registry.tools(execution.workspaceId, (id) => execution.processSessionIds.add(id))
        .map((tool) => ({
          ...tool,
          execute: async (args: unknown, context: Parameters<typeof tool.execute>[1]) => {
            if (++calls > MAX_CALLS) throw new Error(`Code Mode limit exceeded: ${MAX_CALLS} tool calls.`);
            if (active >= MAX_CONCURRENT_CALLS) await new Promise<void>((resolve) => waiters.push(resolve));
            active++;
            try {
              if (execution.controller.signal.aborted) throw new Error("Code execution cancelled.");
              return await tool.execute(args, context);
            } finally {
              active--;
              waiters.shift()?.();
            }
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
      if (execution.status !== "completed") this.terminateProcesses(execution);
      execution.finishedAt = performance.now();
      execution.cleanupTimer = setTimeout(() => this.executions.delete(execution.id), COMPLETED_TTL_MS);
      execution.cleanupTimer.unref();
    }
  }
}
