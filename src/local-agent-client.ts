import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { matchError, Result, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import {
  AgentDaemonInvalidRequestError,
  AgentDaemonInvalidResponseError,
  AgentDaemonProtocolMismatchError,
  AgentDaemonStartupError,
  AgentDaemonTimeoutError,
  AgentDaemonUnauthorizedError,
  AgentDaemonUnavailableError,
  agentErrorFromPayload,
  isAgentDaemonError,
  isProgrammerDefect,
  type AgentDaemonError,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  decodeAgentRecord,
  decodeAgentRecordList,
  decodeDaemonLogs,
  decodeDaemonStatus,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonRequest,
  LocalAgentDaemonProtocolError,
  type LocalAgentDaemonErrorPayload,
  type LocalAgentDaemonRequest,
  type LocalAgentDaemonResponse,
  type LocalAgentDaemonStatus,
} from "./local-agent-daemon-protocol.js";
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ensureLocalAgentDaemonSecret,
  isProcessAlive,
  localAgentDaemonPaths,
  readLocalAgentDaemonSecret,
  type LocalAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import type {
  AgentContinueError,
  AgentListError,
  AgentLookupError,
  AgentStartError,
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 40;

type RequestError<M extends LocalAgentDaemonRequest["method"]> =
  M extends "agent.start" ? AgentStartError | AgentDaemonError
    : M extends "agent.continue" ? AgentContinueError | AgentDaemonError
      : M extends "agent.get" ? AgentLookupError | AgentDaemonError
        : M extends "agent.list" ? AgentListError | AgentDaemonError
          : AgentDaemonError;

export interface LocalAgentClientOptions {
  stateDir: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawnDaemon?: () => void;
  endpoint?: string;
}

export class LocalAgentClient {
  private readonly stateDir: string;
  private readonly paths: LocalAgentDaemonPaths;
  private readonly endpoint: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly spawnDaemon: () => void;
  private startupPromise?: Promise<BetterResult<LocalAgentDaemonStatus, AgentDaemonError>>;

  constructor(options: LocalAgentClientOptions) {
    this.stateDir = options.stateDir;
    this.paths = localAgentDaemonPaths(options.stateDir);
    this.endpoint = options.endpoint ?? this.paths.endpoint;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnDaemon = options.spawnDaemon ?? (() => spawnLocalAgentDaemon(options.stateDir));
  }

  async run(
    input: StartLocalAgentInput,
  ): Promise<BetterResult<LocalAgentRecord, AgentStartError | AgentDaemonError>> {
    return this.start(input);
  }

  async start(
    input: StartLocalAgentInput,
  ): Promise<BetterResult<LocalAgentRecord, AgentStartError | AgentDaemonError>> {
    const result = await this.request("agent.start", input);
    return decodeRequestResult(result, "agent.start", decodeAgentRecord);
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError | AgentDaemonError>> {
    const result = await this.request("agent.continue", {
      id: agentId,
      prompt,
      scope,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    return decodeRequestResult(result, "agent.continue", decodeAgentRecord);
  }

  async get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentLookupError | AgentDaemonError>> {
    const result = await this.request("agent.get", { id: agentId, scope });
    return decodeRequestResult(result, "agent.get", decodeAgentRecord);
  }

  async list(
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord[], AgentListError | AgentDaemonError>> {
    const result = await this.request("agent.list", scope);
    return decodeRequestResult(result, "agent.list", decodeAgentRecordList);
  }

  async status(): Promise<BetterResult<LocalAgentDaemonStatus, AgentDaemonError>> {
    const result = await this.requestExisting("daemon.status", {});
    return decodeRequestResult(result, "daemon.status", decodeDaemonStatus);
  }

  async stop(): Promise<BetterResult<LocalAgentDaemonStatus, AgentDaemonError>> {
    const result = await this.requestExisting("daemon.stop", {});
    return decodeRequestResult(result, "daemon.stop", decodeDaemonStatus);
  }

  async logs(lines = 200): Promise<BetterResult<string, AgentDaemonError>> {
    const result = await this.requestExisting("daemon.logs", { lines });
    return decodeRequestResult(result, "daemon.logs", decodeDaemonLogs);
  }

  async ensureReady(): Promise<BetterResult<LocalAgentDaemonStatus, AgentDaemonError>> {
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.ensureReadyInternal().finally(() => {
      this.startupPromise = undefined;
    });
    return this.startupPromise;
  }

  private async ensureReadyInternal(): Promise<BetterResult<LocalAgentDaemonStatus, AgentDaemonError>> {
    const existing = await this.tryHello();
    if (existing.isErr()) return existing;
    if (existing.value) return Result.ok(existing.value);

    try {
      this.spawnDaemon();
    } catch (cause) {
      return Result.err(new AgentDaemonStartupError({
        code: "DAEMON_STARTUP_FAILURE",
        operation: "startup",
        retryable: true,
        cause,
        message: `Unable to start the local agent daemon in ${this.stateDir}.`,
      }));
    }
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: AgentDaemonError | undefined;
    while (Date.now() < deadline) {
      await delay(RETRY_DELAY_MS);
      const ready = await this.tryHello();
      if (ready.isErr()) {
        lastError = ready.error;
        if (
          ready.error.code === "DAEMON_PROTOCOL_MISMATCH"
          || ready.error.code === "DAEMON_INVALID_RESPONSE"
        ) return ready;
        continue;
      }
      if (ready.value) return Result.ok(ready.value);
    }
    return Result.err(new AgentDaemonStartupError({
      code: "DAEMON_STARTUP_FAILURE",
      operation: "startup",
      retryable: true,
      cause: lastError,
      message: `Unable to start the local agent daemon in ${this.stateDir}.`,
    }));
  }

  private async tryHello(): Promise<BetterResult<LocalAgentDaemonStatus | undefined, AgentDaemonError>> {
    const authToken = this.authTokenResult("hello");
    if (authToken.isErr()) return authToken;
    const response = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      authToken: authToken.value,
      method: "hello",
      params: {},
    }, this.requestTimeoutMs);
    if (response.isErr()) {
      if (
        response.error.code === "DAEMON_UNAVAILABLE"
        || response.error.code === "DAEMON_TIMEOUT"
      ) return Result.ok(undefined);
      return response;
    }
    if (!response.value.ok) {
      const error = decodeRemoteError(response.value.error, "hello");
      if (!isAgentDaemonError(error)) {
        return Result.err(new AgentDaemonInvalidResponseError({
          code: "DAEMON_INVALID_RESPONSE",
          operation: "hello",
          retryable: false,
          cause: response.value.error,
          message: "Local agent daemon returned an invalid hello error.",
        }));
      }
      if (
        error.code === "DAEMON_PROTOCOL_MISMATCH"
        && response.value.protocolVersion < LOCAL_AGENT_DAEMON_PROTOCOL_VERSION
      ) {
        return this.replaceIdleOlderDaemon(authToken.value, response.value.protocolVersion, error);
      }
      return error.code === "DAEMON_UNAVAILABLE" ? Result.ok(undefined) : Result.err(error);
    }
    const decoded = decodeValue(response.value.result, "hello", decodeDaemonStatus);
    return decoded.map((status) => status.state === "ready" ? status : undefined);
  }

  private async replaceIdleOlderDaemon(
    authToken: string,
    protocolVersion: number,
    mismatch: AgentDaemonProtocolMismatchError,
  ): Promise<BetterResult<LocalAgentDaemonStatus | undefined, AgentDaemonError>> {
    const statusResponse = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion,
      authToken,
      method: "hello",
      params: {},
    }, this.requestTimeoutMs);
    if (statusResponse.isErr() || !statusResponse.value.ok) return Result.err(mismatch);
    const status = decodeValue(statusResponse.value.result, "hello", decodeDaemonStatus);
    if (status.isErr()) return status;
    if (status.value.activeTurns > 0) {
      return Result.err(new AgentDaemonProtocolMismatchError({
        code: "DAEMON_PROTOCOL_MISMATCH",
        operation: "startup",
        retryable: true,
        cause: mismatch,
        message: "An older local agent daemon is still running active turns. Retry after they finish.",
      }));
    }

    const stopResponse = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion,
      authToken,
      method: "daemon.stop",
      params: {},
    }, this.requestTimeoutMs);
    if (stopResponse.isErr() || !stopResponse.value.ok) return Result.err(mismatch);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await delay(RETRY_DELAY_MS);
      const probe = await sendRequest(this.endpoint, {
        requestId: randomUUID(),
        protocolVersion,
        authToken,
        method: "hello",
        params: {},
      }, Math.min(this.requestTimeoutMs, 250));
      if (probe.isErr() && probe.error.code === "DAEMON_UNAVAILABLE") {
        if (!existsSync(this.paths.lockPath) || !isProcessAlive(status.value.pid)) {
          return Result.ok(undefined);
        }
        continue;
      }
      if (
        probe.isOk()
        && probe.value.protocolVersion >= LOCAL_AGENT_DAEMON_PROTOCOL_VERSION
      ) {
        // Another client completed the replacement while this client was
        // waiting for the old endpoint to disappear.
        return this.tryHello();
      }
    }
    return Result.err(new AgentDaemonStartupError({
      code: "DAEMON_STARTUP_FAILURE",
      operation: "startup",
      retryable: true,
      cause: mismatch,
      message: "The older local agent daemon did not stop in time for the upgrade.",
    }));
  }

  private async request<M extends LocalAgentDaemonRequest["method"]>(
    method: M,
    params: Extract<LocalAgentDaemonRequest, { method: M }>['params'],
  ): Promise<BetterResult<unknown, RequestError<M>>> {
    const ready = await this.ensureReady();
    if (ready.isErr()) return ready as BetterResult<unknown, RequestError<M>>;
    const authToken = this.authTokenResult(method);
    if (authToken.isErr()) return authToken as BetterResult<unknown, RequestError<M>>;
    const response = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      authToken: authToken.value,
      method,
      params,
    } as LocalAgentDaemonRequest, this.requestTimeoutMs);
    if (response.isErr()) return response as BetterResult<unknown, RequestError<M>>;
    if (!response.value.ok) {
      const error = decodeRemoteError(response.value.error, method);
      if (!isRequestError(method, error)) {
        return Result.err(new AgentDaemonInvalidResponseError({
          code: "DAEMON_INVALID_RESPONSE",
          operation: method,
          retryable: false,
          cause: response.value.error,
          message: "Local agent daemon returned an error that is invalid for this request.",
        })) as BetterResult<unknown, RequestError<M>>;
      }
      return Result.err(error) as BetterResult<unknown, RequestError<M>>;
    }
    return Result.ok(response.value.result);
  }

  private async requestExisting<M extends LocalAgentDaemonRequest["method"]>(
    method: M,
    params: Extract<LocalAgentDaemonRequest, { method: M }>['params'],
  ): Promise<BetterResult<unknown, AgentDaemonError>> {
    const authToken = this.existingAuthTokenResult(method);
    if (authToken.isErr()) return authToken;
    if (!authToken.value) {
      return Result.err(new AgentDaemonUnavailableError({
        code: "DAEMON_UNAVAILABLE",
        operation: method,
        retryable: true,
        message: "Local agent daemon is not running.",
      }));
    }
    const response = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      authToken: authToken.value,
      method,
      params,
    } as LocalAgentDaemonRequest, this.requestTimeoutMs);
    if (response.isErr()) return response;
    if (!response.value.ok) {
      const error = decodeRemoteError(response.value.error, method);
      if (isAgentDaemonError(error)) return Result.err(error);
      return Result.err(new AgentDaemonInvalidResponseError({
        code: "DAEMON_INVALID_RESPONSE",
        operation: method,
        retryable: false,
        cause: response.value.error,
        message: "Local agent daemon returned an invalid daemon-control error.",
      }));
    }
    return Result.ok(response.value.result);
  }

  private authTokenResult(
    operation: string,
  ): BetterResult<string, AgentDaemonUnavailableError> {
    try {
      return Result.ok(ensureLocalAgentDaemonSecret(this.paths));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentDaemonUnavailableError({
        code: "DAEMON_UNAVAILABLE",
        operation,
        retryable: false,
        cause,
        message: "Local agent daemon credentials are unavailable.",
      }));
    }
  }

  private existingAuthTokenResult(
    operation: string,
  ): BetterResult<string | undefined, AgentDaemonUnavailableError> {
    try {
      return Result.ok(readLocalAgentDaemonSecret(this.paths));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentDaemonUnavailableError({
        code: "DAEMON_UNAVAILABLE",
        operation,
        retryable: false,
        cause,
        message: "Local agent daemon credentials are unavailable.",
      }));
    }
  }
}

export function createLocalAgentClient(config: Pick<ServerConfig, "stateDir">): LocalAgentClient {
  return new LocalAgentClient({ stateDir: config.stateDir });
}

export function spawnLocalAgentDaemon(stateDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const entrypoint = resolveDaemonEntrypoint();
  const child = spawn(process.execPath, [...daemonExecArgv(process.execArgv), entrypoint], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, DEVSPACE_STATE_DIR: stateDir },
  });
  child.unref();
}

export function daemonExecArgv(execArgv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index]!;
    if (/^--inspect(?:-brk|-wait)?(?:=.*)?$/.test(argument)) continue;
    if (argument === "--inspect-port") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--inspect-port=")) continue;
    result.push(argument);
  }
  return result;
}

export function resolveDaemonEntrypoint(): string {
  const compiled = fileURLToPath(new URL("./local-agent-daemon-main.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL("./local-agent-daemon-main.ts", import.meta.url));
}

async function sendRequest(
  endpoint: string,
  request: LocalAgentDaemonRequest,
  timeoutMs: number,
): Promise<BetterResult<LocalAgentDaemonResponse, AgentDaemonError>> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(Result.err(new AgentDaemonTimeoutError({
        code: "DAEMON_TIMEOUT",
        operation: request.method,
        retryable: true,
        message: "Timed out waiting for the local agent daemon.",
      })), true);
    }, timeoutMs);

    const finish = (
      result: BetterResult<LocalAgentDaemonResponse, AgentDaemonError>,
      destroy = false,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroy) socket.destroy();
      resolve(result);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = decodeLocalAgentDaemonResponse(JSON.parse(buffer.slice(0, newline)) as unknown);
        if (response.requestId !== request.requestId) {
          throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon response request id did not match.");
        }
        finish(Result.ok(response));
        socket.end();
      } catch (cause) {
        finish(Result.err(new AgentDaemonInvalidResponseError({
          code: "DAEMON_INVALID_RESPONSE",
          operation: request.method,
          retryable: false,
          cause,
          message: "Local agent daemon returned an invalid response.",
        })), true);
      }
    });
    socket.once("error", (cause) => finish(Result.err(new AgentDaemonUnavailableError({
      code: "DAEMON_UNAVAILABLE",
      operation: request.method,
      retryable: true,
      cause,
      message: "Local agent daemon is unavailable.",
    }))));
    socket.once("close", () => {
      if (!settled) {
        finish(Result.err(new AgentDaemonUnavailableError({
          code: "DAEMON_UNAVAILABLE",
          operation: request.method,
          retryable: true,
          message: "Local agent daemon closed the connection.",
        })));
      }
    });
    socket.once("connect", () => socket.write(encodeLocalAgentDaemonRequest(request)));
  });
}

function decodeRequestResult<T, E extends LocalAgentError>(
  result: BetterResult<unknown, E>,
  operation: string,
  decode: (value: unknown) => T,
): BetterResult<T, E | AgentDaemonInvalidResponseError> {
  return result.andThen((value) => decodeValue(value, operation, decode));
}

function decodeValue<T>(
  value: unknown,
  operation: string,
  decode: (value: unknown) => T,
): BetterResult<T, AgentDaemonInvalidResponseError> {
  try {
    return Result.ok(decode(value));
  } catch (cause) {
    return Result.err(new AgentDaemonInvalidResponseError({
      code: "DAEMON_INVALID_RESPONSE",
      operation,
      retryable: false,
      cause,
      message: "Local agent daemon returned an invalid response.",
    }));
  }
}

function decodeRemoteError(
  payload: LocalAgentDaemonErrorPayload,
  operation: string,
): LocalAgentError {
  const decoded = agentErrorFromPayload(payload);
  return decoded ?? new AgentDaemonInvalidResponseError({
    code: "DAEMON_INVALID_RESPONSE",
    operation,
    retryable: false,
    cause: payload,
    message: "Local agent daemon returned an unknown error code.",
  });
}

function isRequestError(
  method: LocalAgentDaemonRequest["method"],
  error: LocalAgentError,
): boolean {
  const category = matchError(error, {
    AgentTargetError: () => "target" as const,
    AgentConflictError: () => "conflict" as const,
    AgentScopeError: () => "scope" as const,
    AgentProviderUnavailableError: () => "provider" as const,
    AgentProviderCancelledError: () => "provider" as const,
    AgentProviderProtocolError: () => "provider" as const,
    AgentProviderExecutionError: () => "provider" as const,
    AgentDaemonUnavailableError: () => "daemon" as const,
    AgentDaemonStartupError: () => "daemon" as const,
    AgentDaemonTimeoutError: () => "daemon" as const,
    AgentDaemonProtocolMismatchError: () => "daemon" as const,
    AgentDaemonUnauthorizedError: () => "daemon" as const,
    AgentDaemonInvalidRequestError: () => "daemon" as const,
    AgentDaemonInvalidResponseError: () => "daemon" as const,
    AgentDaemonInternalError: () => "daemon" as const,
    AgentStoreError: () => "store" as const,
  });
  if (category === "daemon") return true;
  switch (method) {
    case "agent.start":
    case "agent.continue":
      return category === "target"
        || category === "scope"
        || category === "conflict"
        || category === "store";
    case "agent.get":
      return category === "target" || category === "scope" || category === "store";
    case "agent.list":
      return category === "scope" || category === "store";
    case "hello":
    case "daemon.status":
    case "daemon.stop":
    case "daemon.logs":
      return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
