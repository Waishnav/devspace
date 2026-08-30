import { timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import {
  AgentDaemonInternalError,
  AgentDaemonInvalidRequestError,
  AgentDaemonInvalidResponseError,
  AgentDaemonProtocolMismatchError,
  AgentDaemonTimeoutError,
  AgentDaemonUnauthorizedError,
  AgentDaemonUnavailableError,
  isLocalAgentError,
  toAgentErrorPayload,
} from "./local-agent-errors.js";
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  LocalAgentDaemonAlreadyRunningError,
  LocalAgentDaemonLock,
  ensureLocalAgentDaemonStateDir,
  ensureLocalAgentDaemonSecret,
  localAgentDaemonPaths,
  removeLocalAgentDaemonFiles,
  type LocalAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import {
  decodeLocalAgentDaemonRequest,
  encodeLocalAgentDaemonResponse,
  type LocalAgentDaemonRequest,
  type LocalAgentDaemonErrorPayload,
  type LocalAgentDaemonResponse,
  type LocalAgentDaemonStatus,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";
import type { Result } from "better-result";
import type {
  AgentContinueError,
  AgentListError,
  AgentLookupError,
  AgentStartError,
  AgentWaitError,
  LocalAgentWaitResult,
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_DAEMON_IDLE_SHUTDOWN_MS = 30_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_READ_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface LocalAgentDaemonManager {
  start(input: StartLocalAgentInput): Promise<Result<LocalAgentRecord, AgentStartError>>;
  continue(agentId: string, prompt: string, overrides: RunOverrides | undefined, scope: LocalAgentWorkspaceScope): Promise<Result<LocalAgentRecord, AgentContinueError>>;
  get(agentId: string, scope: LocalAgentWorkspaceScope): Result<LocalAgentRecord, AgentLookupError>;
  list(scope: LocalAgentWorkspaceScope): Result<LocalAgentRecord[], AgentListError>;
  wait(
    agentIds: readonly string[],
    scope: LocalAgentWorkspaceScope,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Result<LocalAgentWaitResult[], AgentWaitError>>;
  evictIdle(now?: number): Promise<void>;
  close(): Promise<void>;
  readonly activeTurnCount: number;
  readonly runtimeCount: number;
}

export interface LocalAgentDaemonOptions {
  stateDir: string;
  manager: LocalAgentDaemonManager;
  idleShutdownMs?: number;
  idleCheckIntervalMs?: number;
  requestReadTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
  paths?: LocalAgentDaemonPaths;
  onLockAcquired?: () => void | Promise<void>;
  onClosed?: () => void;
}

export class LocalAgentDaemon {
  readonly paths: LocalAgentDaemonPaths;
  private readonly manager: LocalAgentDaemonManager;
  private readonly lock: LocalAgentDaemonLock;
  private readonly idleShutdownMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly requestReadTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => number;
  private readonly onLockAcquired?: () => void | Promise<void>;
  private readonly onClosed?: () => void;
  private readonly sockets = new Set<Socket>();
  private server?: NetServer;
  private idleTimer?: NodeJS.Timeout;
  private idleSince?: number;
  private closePromise?: Promise<void>;
  private startedAt?: string;
  private accepting = false;
  private stopping = false;
  private authToken?: string;
  private ownsLock = false;

  constructor(options: LocalAgentDaemonOptions) {
    this.paths = options.paths ?? localAgentDaemonPaths(options.stateDir);
    this.manager = options.manager;
    this.lock = new LocalAgentDaemonLock(this.paths);
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_DAEMON_IDLE_SHUTDOWN_MS;
    this.idleCheckIntervalMs = options.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;
    this.requestReadTimeoutMs = options.requestReadTimeoutMs ?? DEFAULT_REQUEST_READ_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.onLockAcquired = options.onLockAcquired;
    this.onClosed = options.onClosed;
    if (!Number.isFinite(this.idleShutdownMs) || this.idleShutdownMs < 0) {
      throw new Error("Agent daemon idle shutdown must be a non-negative finite duration.");
    }
    if (!Number.isFinite(this.requestReadTimeoutMs) || this.requestReadTimeoutMs <= 0) {
      throw new Error("Agent daemon request read timeout must be a positive finite duration.");
    }
    if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 0) {
      throw new Error("Agent daemon shutdown timeout must be a non-negative finite duration.");
    }
  }

  async start(): Promise<LocalAgentDaemonStatus> {
    if (this.server) return this.status();
    ensureLocalAgentDaemonStateDir(this.paths.stateDir);
    let lockAcquired = false;
    try {
      this.lock.acquire();
      lockAcquired = true;
      this.ownsLock = true;
      this.authToken = ensureLocalAgentDaemonSecret(this.paths);
      await this.onLockAcquired?.();
      if (process.platform !== "win32") rmSync(this.paths.socketPath, { force: true });
      const server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      await listen(server, this.paths.endpoint);
      if (process.platform !== "win32") chmodSync(this.paths.socketPath, 0o600);
      this.startedAt = new Date(this.now()).toISOString();
      this.accepting = true;
      this.stopping = false;
      this.idleTimer = setInterval(() => {
        void this.maintainIdle().catch((error) => {
          writeLocalAgentDaemonLog(this.paths, "warn", "daemon_idle_check_failed", {
            error: errorMessage(error),
          });
        });
      }, this.idleCheckIntervalMs);
      this.idleTimer.unref();
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_started", { pid: process.pid });
      return this.status();
    } catch (error) {
      this.server = undefined;
      this.authToken = undefined;
      if (lockAcquired) {
        this.lock.release();
        this.ownsLock = false;
        removeLocalAgentDaemonFiles(this.paths);
      }
      if (error instanceof LocalAgentDaemonAlreadyRunningError) throw error;
      throw error;
    }
  }

  status(): LocalAgentDaemonStatus {
    if (!this.startedAt) throw new Error("Local agent daemon is not started.");
    return {
      state: this.stopping ? "stopping" : "ready",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      endpoint: this.paths.endpoint,
      startedAt: this.startedAt,
      activeTurns: this.manager.activeTurnCount,
      runtimeCount: this.manager.runtimeCount,
      clientConnections: this.sockets.size,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.ownsLock && !this.server) return;
    this.accepting = false;
    this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.closePromise = (async () => {
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_stopping", {
        activeTurns: this.manager.activeTurnCount,
        runtimeCount: this.manager.runtimeCount,
      });
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      const [serverResult, managerResult] = await Promise.allSettled([
        withTimeout(closeServer(this.server), this.shutdownTimeoutMs, "daemon socket shutdown"),
        withTimeout(this.manager.close(), this.shutdownTimeoutMs, "daemon manager shutdown"),
      ]);
      if (serverResult.status === "rejected") {
        writeLocalAgentDaemonLog(this.paths, "warn", "daemon_socket_close_failed", {
          error: errorMessage(serverResult.reason),
        });
      }
      if (managerResult.status === "rejected") {
        writeLocalAgentDaemonLog(this.paths, "warn", "daemon_manager_close_failed", {
          error: errorMessage(managerResult.reason),
        });
      }
      removeLocalAgentDaemonFiles(this.paths);
      this.lock.release();
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_stopped", {});
      this.server = undefined;
      this.authToken = undefined;
      this.onClosed?.();
    })();
    return this.closePromise;
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    const disconnected = new AbortController();
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    const requestTimer = setTimeout(() => {
      if (handled) return;
      handled = true;
      this.writeError(socket, "", toAgentErrorPayload(new AgentDaemonTimeoutError({
        code: "DAEMON_TIMEOUT",
        message: "Timed out waiting for a complete daemon request.",
        retryable: true,
        operation: "request",
      })));
      socket.destroy();
    }, this.requestReadTimeoutMs);
    requestTimer.unref();
    socket.on("data", (chunk: string | Buffer) => {
      if (handled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        this.writeError(socket, "", toAgentErrorPayload(new AgentDaemonInvalidRequestError({
          code: "DAEMON_INVALID_REQUEST",
          message: "Daemon request is too large.",
          retryable: false,
          operation: "request",
        })));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      clearTimeout(requestTimer);
      const line = buffer.slice(0, newline);
      void this.handleLine(socket, line, disconnected.signal);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      disconnected.abort();
      this.sockets.delete(socket);
    });
    socket.on("error", () => clearTimeout(requestTimer));
  }

  private async handleLine(socket: Socket, line: string, signal: AbortSignal): Promise<void> {
    let requestId = "";
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new LocalAgentDaemonProtocolError("INVALID_REQUEST", "Daemon request is not valid JSON.", { cause });
      }
      requestId = readRequestId(parsed);
      const request = decodeLocalAgentDaemonRequest(parsed);
      const response = await this.dispatch(request, signal);
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        ok: true,
        result: response,
      }));
      if (request.method === "daemon.stop") setImmediate(() => { void this.close(); });
    } catch (error) {
      this.writeError(socket, requestId, daemonErrorPayload(error));
    }
  }

  private async dispatch(request: LocalAgentDaemonRequest, signal: AbortSignal): Promise<unknown> {
    if (request.protocolVersion !== LOCAL_AGENT_DAEMON_PROTOCOL_VERSION) {
      throw new LocalAgentDaemonProtocolError(
        "PROTOCOL_MISMATCH",
        `Unsupported daemon protocol version ${request.protocolVersion}; expected ${LOCAL_AGENT_DAEMON_PROTOCOL_VERSION}.`,
      );
    }
    this.assertAuthenticated(request.authToken);
    if (!this.accepting && request.method !== "hello" && request.method !== "daemon.status") {
      throw new AgentDaemonUnavailableError({
        code: "DAEMON_UNAVAILABLE",
        operation: request.method,
        retryable: true,
        message: "Local agent daemon is stopping.",
      });
    }

    switch (request.method) {
      case "hello":
        return this.status();
      case "agent.start":
        return unwrapManagerResult(await this.manager.start(request.params));
      case "agent.continue":
        return unwrapManagerResult(await this.manager.continue(
          request.params.id,
          request.params.prompt,
          request.params.overrides,
          request.params.scope,
        ));
      case "agent.get":
        return unwrapManagerResult(this.manager.get(request.params.id, request.params.scope));
      case "agent.list":
        return unwrapManagerResult(this.manager.list(request.params));
      case "agent.wait":
        return unwrapManagerResult(await this.manager.wait(
          request.params.ids,
          request.params.scope,
          request.params.timeoutMs,
          signal,
        ));
      case "daemon.status":
        return this.status();
      case "daemon.stop":
        this.stopping = true;
        this.accepting = false;
        return this.status();
      case "daemon.logs":
        return readLocalAgentDaemonLogs(this.paths, request.params.lines);
    }
  }

  private writeError(socket: Socket, requestId: string, error: LocalAgentDaemonErrorPayload): void {
    socket.end(encodeLocalAgentDaemonResponse({
      requestId,
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: false,
      error,
    }), () => socket.destroy());
  }

  private assertAuthenticated(authToken: string): void {
    const expected = this.authToken;
    if (!expected || !safeEqual(authToken, expected)) {
      throw new LocalAgentDaemonProtocolError("UNAUTHORIZED", "Invalid local agent daemon credentials.");
    }
  }

  private async maintainIdle(): Promise<void> {
    await this.manager.evictIdle(this.now());
    if (this.stopping || this.manager.activeTurnCount > 0 || this.manager.runtimeCount > 0 || this.sockets.size > 0) {
      this.idleSince = undefined;
      return;
    }
    const now = this.now();
    this.idleSince ??= now;
    if (now - this.idleSince >= this.idleShutdownMs) await this.close();
  }
}

async function listen(server: NetServer, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

async function closeServer(server: NetServer | undefined): Promise<void> {
  if (!server) return;
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  if (timeoutMs === 0) {
    throw new Error(`${operation} timed out.`);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readRequestId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : "";
}

export function writeLocalAgentDaemonLog(
  paths: LocalAgentDaemonPaths,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    ensureLocalAgentDaemonStateDir(paths.stateDir);
    appendFileSync(paths.logPath, `${JSON.stringify({ at: new Date().toISOString(), level, event, ...fields })}\n`, { mode: 0o600 });
    chmodSync(paths.logPath, 0o600);
  } catch {
    // Diagnostics must never break agent execution or shutdown.
  }
}

export function readLocalAgentDaemonLogs(paths: LocalAgentDaemonPaths, lines = 200): string {
  try {
    const content = readFileSync(paths.logPath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, lines)).join("\n");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function daemonErrorPayload(error: unknown): LocalAgentDaemonErrorPayload {
  if (isLocalAgentError(error)) return toAgentErrorPayload(error);
  if (error instanceof LocalAgentDaemonProtocolError) {
    if (error.code === "PROTOCOL_MISMATCH") {
      return toAgentErrorPayload(new AgentDaemonProtocolMismatchError({
        code: "DAEMON_PROTOCOL_MISMATCH",
        operation: "request",
        retryable: false,
        cause: error,
        message: error.message,
      }));
    }
    if (error.code === "UNAUTHORIZED") {
      return toAgentErrorPayload(new AgentDaemonUnauthorizedError({
        code: "DAEMON_UNAUTHORIZED",
        operation: "request",
        retryable: false,
        cause: error,
        message: error.message,
      }));
    }
    return toAgentErrorPayload(new AgentDaemonInvalidRequestError({
      code: "DAEMON_INVALID_REQUEST",
      operation: "request",
      retryable: false,
      cause: error,
      message: error.message,
    }));
  }
  return toAgentErrorPayload(new AgentDaemonInternalError({
    code: "DAEMON_INTERNAL_ERROR",
    operation: "request",
    retryable: false,
    cause: error,
    message: "Local agent daemon encountered an unexpected internal failure.",
  }));
}

function unwrapManagerResult<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
