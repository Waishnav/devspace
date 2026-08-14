import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES_CAP = 16 * 1024 * 1024;

export const ALLOWED_CODEX_APP_SERVER_METHODS = new Set([
  "initialize",
  "process/spawn",
  "process/writeStdin",
  "process/kill",
]);

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexAppServerError";
  }
}

export interface CodexAppServerClientOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  spawnImpl?: typeof spawn;
  onMethod?: (method: string) => void;
}

export interface SpawnCodexProcessInput {
  command: string[];
  cwd: string;
  env?: Record<string, string | null>;
  timeoutMs?: number | null;
  outputBytesCap?: number | null;
  processHandle?: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type NotificationListener = (notification: JsonRpcNotification) => void;

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly pending = new Map<number, PendingRequest>();
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new CodexAppServerError(
        "Codex app-server client is closed.",
        "codex_app_server_closed",
      );
    }
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    await this.start();
    this.assertAllowedMethod(method);
    this.options.onMethod?.(method);

    const child = this.requireChild();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(
          `Codex app-server request timed out: ${method}`,
          "codex_app_server_request_timeout",
        ));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(payload, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new CodexAppServerError(
          `Unable to write Codex app-server request: ${method}`,
          "codex_app_server_write_failed",
          { cause: error },
        ));
      });
    });
  }

  async spawnProcess(input: SpawnCodexProcessInput): Promise<CodexSpawnedProcess> {
    const processHandle = input.processHandle ?? `devspace-${randomUUID()}`;
    const process = new CodexSpawnedProcess(this, processHandle);
    process.attach();
    try {
      await this.request("process/spawn", {
        command: input.command,
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        processHandle,
        streamStdin: true,
        streamStdoutStderr: true,
        tty: false,
        timeoutMs: input.timeoutMs ?? null,
        outputBytesCap: input.outputBytesCap ?? DEFAULT_OUTPUT_BYTES_CAP,
      });
      process.markStarted();
      return process;
    } catch (error) {
      process.detach();
      throw error;
    }
  }

  subscribe(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(
        this.options.executable,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            ...this.options.env,
            NO_COLOR: "1",
            TERM: "dumb",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw new CodexAppServerError(
        "Unable to start Codex app-server.",
        "codex_app_server_spawn_failed",
        { cause: error },
      );
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.ingestStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = tail(`${this.stderrBuffer}${chunk}`, 64 * 1024);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const stderr = this.stderrBuffer.trim();
      this.handleExit(new CodexAppServerError(
        stderr
          ? `Codex app-server exited with ${detail}: ${stderr}`
          : `Codex app-server exited with ${detail}.`,
        "codex_app_server_exited",
      ));
    });

    await this.requestWithoutStart("initialize", {
      clientInfo: {
        name: this.options.clientName ?? "devspace",
        version: this.options.clientVersion ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
  }

  private async requestWithoutStart<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.assertAllowedMethod(method);
    this.options.onMethod?.(method);
    const child = this.requireChild();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(
          `Codex app-server request timed out: ${method}`,
          "codex_app_server_request_timeout",
        ));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", "utf8");
    });
  }

  private ingestStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if ((typeof message.id === "number" || typeof message.id === "string")
      && ("result" in message || "error" in message)) {
      this.handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    if (typeof message.method === "string") {
      const notification: JsonRpcNotification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new CodexAppServerError(
        response.error.message ?? `Codex app-server request failed: ${pending.method}`,
        "codex_app_server_request_failed",
      ));
      return;
    }
    pending.resolve(response.result);
  }

  private handleExit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.notificationListeners) {
      listener({ method: "devspace/appServerExited", params: { message: error.message } });
    }
  }

  private assertAllowedMethod(method: string): void {
    if (!ALLOWED_CODEX_APP_SERVER_METHODS.has(method)) {
      throw new CodexAppServerError(
        `DevSpace refuses Codex app-server method ${method}; model thread and turn APIs are outside the local execution boundary.`,
        "codex_app_server_method_forbidden",
      );
    }
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || this.closed) {
      throw new CodexAppServerError(
        "Codex app-server is not running.",
        "codex_app_server_not_running",
      );
    }
    return this.child;
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerError(
        "Codex app-server closed before the request completed.",
        "codex_app_server_closed",
      ));
    }
    this.pending.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

export type CodexProcessOutputStream = "stdout" | "stderr";
export type CodexProcessOutputListener = (
  stream: CodexProcessOutputStream,
  data: Buffer,
) => void;

export interface CodexProcessExit {
  exitCode: number;
  stdoutCapReached: boolean;
  stderrCapReached: boolean;
}

export class CodexSpawnedProcess {
  private readonly outputListeners = new Set<CodexProcessOutputListener>();
  private readonly exitListeners = new Set<(exit: CodexProcessExit) => void>();
  private unsubscribe?: () => void;
  private exit?: CodexProcessExit;
  private started = false;
  private writeChain = Promise.resolve();

  constructor(
    private readonly appServer: CodexAppServerClient,
    readonly processHandle: string,
  ) {}

  attach(): void {
    this.unsubscribe = this.appServer.subscribe((notification) => {
      const params = isRecord(notification.params) ? notification.params : {};
      if (params.processHandle !== this.processHandle) return;
      if (notification.method === "process/outputDelta") {
        const stream = params.stream;
        const deltaBase64 = params.deltaBase64;
        if ((stream !== "stdout" && stream !== "stderr") || typeof deltaBase64 !== "string") return;
        const data = Buffer.from(deltaBase64, "base64");
        for (const listener of this.outputListeners) listener(stream, data);
        return;
      }
      if (notification.method === "process/exited") {
        const exit: CodexProcessExit = {
          exitCode: typeof params.exitCode === "number" ? params.exitCode : 1,
          stdoutCapReached: params.stdoutCapReached === true,
          stderrCapReached: params.stderrCapReached === true,
        };
        this.exit = exit;
        for (const listener of this.exitListeners) listener(exit);
        this.detach();
      }
      if (notification.method === "devspace/appServerExited") {
        const exit: CodexProcessExit = {
          exitCode: 1,
          stdoutCapReached: false,
          stderrCapReached: false,
        };
        this.exit = exit;
        for (const listener of this.exitListeners) listener(exit);
        this.detach();
      }
    });
  }

  markStarted(): void {
    this.started = true;
  }

  onOutput(listener: CodexProcessOutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (exit: CodexProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exit) queueMicrotask(() => listener(this.exit as CodexProcessExit));
    return () => this.exitListeners.delete(listener);
  }

  async write(data: Buffer | string): Promise<void> {
    if (!this.started || this.exit) {
      throw new CodexAppServerError(
        `Codex child process is not running: ${this.processHandle}`,
        "codex_child_not_running",
      );
    }
    const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.writeChain = this.writeChain.then(async () => {
      await this.appServer.request("process/writeStdin", {
        processHandle: this.processHandle,
        deltaBase64: buffer.toString("base64"),
        closeStdin: false,
      });
    });
    return this.writeChain;
  }

  async kill(): Promise<void> {
    if (this.exit || !this.started) {
      this.detach();
      return;
    }
    try {
      await this.appServer.request("process/kill", {
        processHandle: this.processHandle,
      }, 5_000);
    } catch {
      // The child may have exited between the state check and kill request.
    } finally {
      this.detach();
    }
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}
