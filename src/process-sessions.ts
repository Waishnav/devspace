import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: string;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: string;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: string;
  bufferStart: number;
  consumedThrough: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function truncateOutput(output: string, maxOutputTokens: number): { output: string; truncated: boolean } {
  const maxCharacters = Math.max(256, maxOutputTokens * 4);
  if (output.length <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const available = maxCharacters - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    output: output.slice(0, head) + marker + output.slice(output.length - tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty) await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_YIELD_MS, 30_000);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    const hasUnreadOutput = session.consumedThrough < session.bufferStart + session.buffer.length;
    if ((interactionRequested || !hasUnreadOutput) && session.running) {
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_YIELD_MS, 30_000);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: string): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: "",
      bufferStart: 0,
      consumedThrough: 0,
      running: true,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    let scriptDirectory: string | undefined;
    let command = input.command;
    if (process.platform === "win32") {
      scriptDirectory = await mkdtemp(join(tmpdir(), "devspace-pty-"));
      command = join(scriptDirectory, "command.cmd");
      await writeFile(
        command,
        `@ping 127.0.0.1 -n 2 > nul\r\n@echo off\r\n${input.command}\r\n@exit /b %errorlevel%\r\n`,
        "utf8",
      );
    }

    const cleanupScript = (): void => {
      if (scriptDirectory) void rm(scriptDirectory, { recursive: true, force: true });
    };
    const shell = resolveShellCommand(command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment(),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      cleanupScript();
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => process.platform === "win32" ? pty.kill() : pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      cleanupScript();
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer += output;
    if (session.buffer.length <= this.maxBufferCharacters) return;

    const remove = session.buffer.length - this.maxBufferCharacters;
    session.buffer = session.buffer.slice(remove);
    session.bufferStart += remove;
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const missedOutput = session.consumedThrough < session.bufferStart;
    const start = Math.max(0, session.consumedThrough - session.bufferStart);
    const unread = session.buffer.slice(start);
    session.consumedThrough = session.bufferStart + session.buffer.length;

    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const truncated = truncateOutput(unread, limit);

    return {
      sessionId: session.running ? session.id : undefined,
      output: truncated.output,
      outputTruncated: missedOutput || truncated.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: string): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}
