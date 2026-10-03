import { createRequire } from "node:module";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { terminateProcessTree } from "./process-platform.js";

const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECORD_CHARS = 8 * 1024 * 1024;

export type PiRpcRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PiRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queuedEvents: PiRpcRecord[] = [];
  private readonly eventWaiters: Array<{
    resolve(value: PiRpcRecord): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
  }> = [];
  private nextRequestId = 0;
  private buffer = "";
  private closed = false;
  private failure?: Error;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code) => {
      if (!this.closed) this.fail(new Error(`Pi RPC process exited with code ${code}.`));
    });
  }

  static spawn(input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): PiRpcConnection {
    const detached = process.platform !== "win32";
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached,
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Pi RPC process did not expose stdio pipes.");
    }
    return new PiRpcConnection(child as ChildProcessWithoutNullStreams);
  }

  async request(record: PiRpcRecord, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    this.assertOpen();
    const id = `devspace-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${String(record.type ?? "request")} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...record, id }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async send(record: PiRpcRecord): Promise<void> {
    this.assertOpen();
    await this.write(record);
  }

  async nextEvent(timeoutMs?: number): Promise<PiRpcRecord | undefined> {
    this.assertOpen();
    const queued = this.queuedEvents.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.eventWaiters)[number] = {
        resolve: (value) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(value);
        },
        reject: (error) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(error);
        },
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.eventWaiters.indexOf(waiter);
          if (index >= 0) this.eventWaiters.splice(index, 1);
          resolve(undefined);
        }, timeoutMs);
        waiter.timer.unref();
      }
      this.eventWaiters.push(waiter);
    });
  }

  isAlive(): boolean {
    return !this.closed && !this.failure && this.child.exitCode === null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const detached = process.platform !== "win32";
    terminateProcessTree(this.child, "SIGTERM", detached);
    this.fail(new Error("Pi RPC process closed."));
  }

  private async write(record: PiRpcRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_RECORD_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      this.route(parsed as PiRpcRecord);
    }
  }

  private route(record: PiRpcRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success === true) pending.resolve(record.data);
        else pending.reject(new Error(String(record.error ?? `Pi RPC ${String(record.command)} failed.`)));
        return;
      }
    }
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter.resolve(record);
    else this.queuedEvents.push(record);
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Pi RPC process is closed.");
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of this.eventWaiters.splice(0)) waiter.reject(error);
  }
}

export function piRecordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

export function parsePiModelSlug(model: string): { provider: string; modelId: string } | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}
