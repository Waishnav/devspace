import { homedir } from "node:os";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { terminateProcessTree } from "./process-platform.js";
import { DEVSPACE_VERSION } from "./version.js";
import {
  localAgentWorkflowEnvironment,
  type LocalAgentDriver,
  type LocalAgentProgressUpdate,
  type LocalAgentRunCallbacks,
  type LocalAgentRunControl,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
  type LocalAgentRuntime,
  type LocalAgentRuntimeContext,
  type LocalAgentUsageUpdate,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export interface ResolvedCodexCommand {
  executable: string;
  version?: string;
}

export type CodexCommandResolver = (env: NodeJS.ProcessEnv) => ResolvedCodexCommand | undefined;

export function codexCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (env.CODEX_COMMAND) return next;
  if (next.PATH) next.PATH = removeDevspaceNodeModulesBinFromPath(next.PATH);
  return next;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): ResolvedCodexCommand | undefined {
  const command = env.CODEX_COMMAND ?? "codex";
  const probeEnv = codexCommandEnvironment(env);
  for (const candidate of commandCandidates(command, probeEnv)) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: probeEnv,
      windowsHide: true,
      timeout: 5_000,
      shell: usesWindowsCommandShell(candidate),
    });
    const code = result.error && "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT") continue;
    if (result.error || result.status !== 0) continue;
    return { executable: candidate, version: parseCodexVersion(result.stdout) };
  }
  return undefined;
}

export function isCodexAppServerSupported(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = spawnSync(command, ["app-server", "--help"], {
    encoding: "utf8",
    env: codexCommandEnvironment(env),
    windowsHide: true,
    timeout: 5_000,
    shell: usesWindowsCommandShell(command),
  });
  return result.error === undefined && result.status === 0;
}

export function parseCodexVersion(output: string | undefined): string | undefined {
  const match = output?.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

export interface CodexAppServerRuntimeOptions {
  command: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  version?: string;
}

export class CodexAppServerRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: CodexAppServerRpc;
  private alive = true;
  private closePromise?: Promise<void>;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.child = spawn(options.command, options.args ?? ["app-server"], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: usesWindowsCommandShell(options.command),
    });
    this.rpc = new CodexAppServerRpc(this.child, options.version);
    this.child.once("exit", (code, signal) => {
      this.alive = false;
      this.rpc.fail(new Error(
        `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
      ));
    });
    this.child.once("error", (error) => {
      this.alive = false;
      this.rpc.fail(error);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "devspace", title: "DevSpace", version: DEVSPACE_VERSION },
      capabilities: {},
    });
    this.rpc.notify("initialized");
  }

  async run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
    control?: LocalAgentRunControl,
  ) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "Codex app-server is not running.",
          });
        }
        const threadResponse = await this.rpc.request(
          input.providerSessionId ? "thread/resume" : "thread/start",
          threadParams(input),
        );
        const threadId = readString(asRecord(threadResponse)?.thread, "id");
        if (!threadId) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "open_thread",
            retryable: false,
            cause: threadResponse,
            message: "Codex app-server did not return a thread id.",
          });
        }

        await callbacks?.onSessionId?.(threadId);
        let usageSequence = 0;
        let latestUsage: LocalAgentUsageUpdate | undefined;
        const completed = await this.rpc.runTurn(
          threadId,
          turnParams(input, threadId),
          control?.signal,
          async (event) => {
            const progress = codexProgress(event);
            if (progress) await callbacks?.onProgress?.(progress);
            const usage = codexUsage(input, event, ++usageSequence, false);
            if (usage) {
              latestUsage = usage;
              await callbacks?.onUsage?.(usage);
            } else {
              usageSequence -= 1;
            }
          },
        );
        const parsed = parseCompletedTurn(completed.event.params, completed.items);
        if (parsed.cancelled) throw new DOMException("Aborted", "AbortError");
        if (parsed.failure) {
          throw new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            cause: completed.event.params,
            message: "Codex agent turn failed.",
          });
        }
        if (!parsed.finalResponse.trim()) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            cause: completed.event.params,
            message: "Codex did not return a final assistant response.",
          });
        }
        const usage = latestUsage ? { ...latestUsage, sequence: usageSequence + 1, final: true } : undefined;
        if (usage) await callbacks?.onUsage?.(usage);
        const structuredOutput = input.outputSchema ? parseJsonValue(parsed.finalResponse) : undefined;
        return {
          provider: this.provider,
          providerSessionId: threadId,
          finalResponse: parsed.finalResponse.trim(),
          items: parsed.items,
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(usage ? { usage } : {}),
        };
      },
    });
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    if (!this.alive) return;
    try {
      await this.rpc.request("thread/unsubscribe", { threadId: providerSessionId });
    } catch {
      // Unsubscribe is an optimization; persisted thread identity remains valid.
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.alive = false;
      this.rpc.fail(new Error("codex app-server closed."));
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (this.child.exitCode === null) {
        terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
        if (!await waitForProcessExit(this.child, 1_000)) {
          terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32");
        }
      }
    })();
    return this.closePromise;
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class CodexLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "codex" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  private commandResolved = false;
  private resolvedCommand?: ResolvedCodexCommand;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: CodexCommandResolver = resolveCodexCommand,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand();
    const executable = command?.executable ?? this.env.CODEX_COMMAND ?? "codex";
    const codexHome = resolve(this.env.CODEX_HOME ?? join(homedir(), ".codex"));
    return `codex:${executable}:${codexHome}${context.workflowRunId ? `:workflow:${context.workflowRunId}` : ""}`;
  }

  capabilities() {
    return {
      cancellation: "turn",
      structuredOutput: "native",
      usage: "streaming",
      correctionAuthority: "read_only",
      permissionRequests: "preconfigured",
      progress: "tools_and_text",
    } as const;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Codex executable was not found.",
          });
        }
        if (!isCodexAppServerSupported(command.executable, this.env)) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Installed Codex does not support app-server.",
          });
        }
        const runtime = new CodexAppServerRuntime({
          command: command.executable,
          ...(context.workflowRunId
            ? { args: ["app-server", "--disable", "multi_agent", "--disable", "multi_agent_v2"] }
            : {}),
          env: localAgentWorkflowEnvironment(codexCommandEnvironment(this.env), context),
          version: command.version,
        });
        try {
          await runtime.initialize();
          return runtime;
        } catch (cause) {
          await runtime.close();
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "create_runtime",
            retryable: true,
            cause: codexAppServerError(errorMessage(cause), command.version),
            message: "Codex app-server initialization failed.",
          });
        }
      },
    });
  }

  private resolveCommand(): ResolvedCodexCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;

interface CodexEvent {
  method: string;
  params?: unknown;
}

interface CodexTurnResult {
  event: CodexEvent;
  items: unknown[];
}

interface CodexTurnAccumulator {
  threadId: string;
  turnId?: string;
  items: unknown[];
  events: Promise<void>;
  onEvent?: (event: CodexEvent) => void | Promise<void>;
  completed?: CodexEvent;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

class CodexAppServerRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly turns = new Map<string, CodexTurnAccumulator>();
  private nextId = 1;
  private fatalError?: Error;
  private buffer = "";
  private stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly version?: string,
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async runTurn(
    threadId: string,
    params: unknown,
    signal?: AbortSignal,
    onEvent?: (event: CodexEvent) => void | Promise<void>,
  ): Promise<CodexTurnResult> {
    if (this.fatalError) throw this.fatalError;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.turns.has(threadId)) throw new Error(`Codex thread ${threadId} already has an active turn.`);
    let resolveTurn!: (result: CodexTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: CodexTurnAccumulator = {
      threadId,
      items: [],
      events: Promise.resolve(),
      onEvent,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.turns.set(threadId, turn);
    const interrupt = () => {
      if (!turn.turnId) return;
      void this.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      const response = await this.request("turn/start", params);
      turn.turnId = readString(asRecord(response)?.turn, "id");
      if (signal?.aborted) interrupt();
      if (turn.completed) {
        await turn.events;
        return { event: turn.completed, items: turn.items };
      }
      return await completion;
    } finally {
      signal?.removeEventListener("abort", interrupt);
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
    }
  }

  fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = new Error(`${error.message}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}${this.version ? `\ncodex version: ${this.version}` : ""}`);
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    for (const turn of this.turns.values()) turn.reject(this.fatalError);
    this.pending.clear();
    this.turns.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    this.buffer += line;
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fail(new Error("codex app-server emitted malformed JSON."));
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error !== undefined) pending.reject(new Error(protocolErrorText(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (id && method) {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }
    if (!method) return;
    const event = { method, params: message.params };
    const turn = this.findTurn(event);
    if (!turn) return;
    if (turn.onEvent) turn.events = turn.events.then(() => turn.onEvent?.(event));
    const params = asRecord(event.params);
    if (params?.item !== undefined) {
      turn.items.push(params.item);
      if (turn.items.length > MAX_TURN_ITEMS) turn.items.shift();
    }
    if (event.method !== "turn/completed" || !turnMatchesEvent(turn, event)) return;
    turn.completed = event;
    void turn.events.then(
      () => turn.resolve({ event, items: turn.items.slice() }),
      (error) => turn.reject(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private findTurn(event: CodexEvent): CodexTurnAccumulator | undefined {
    const params = asRecord(event.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params?.turnId === "string"
      ? params.turnId
      : readString(asRecord(params?.turn), "id");
    if (threadId) return this.turns.get(threadId);
    if (!turnId) return undefined;
    return Array.from(this.turns.values()).find((turn) => turn.turnId === turnId);
  }
}

function threadParams(input: LocalAgentRunInput): Record<string, unknown> {
  const writeMode = input.toolPolicy === "read_only" || input.toolPolicy === "none"
    ? "read_only"
    : input.writeMode;
  return {
    ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
    cwd: input.workspaceRoot,
    approvalPolicy: "never",
    sandbox: sandboxFor(writeMode),
    ...(input.model ? { model: input.model } : {}),
  };
}

function turnParams(input: LocalAgentRunInput, threadId: string): Record<string, unknown> {
  const writeMode = input.toolPolicy === "read_only" || input.toolPolicy === "none"
    ? "read_only"
    : input.writeMode;
  return {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicyFor(writeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
}

export function sandboxFor(writeMode: LocalAgentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed": return "workspace-write";
    case "full_access": return "danger-full-access";
    case "read_only":
    case undefined: return "read-only";
  }
}

function sandboxPolicyFor(writeMode: LocalAgentWriteMode | undefined): Record<string, string | boolean> {
  switch (writeMode) {
    case "allowed": return { type: "workspaceWrite", networkAccess: true };
    case "full_access": return { type: "dangerFullAccess" };
    case "read_only":
    case undefined: return { type: "readOnly" };
  }
}

function parseCompletedTurn(params: unknown, items: unknown[]): {
  finalResponse: string;
  items: unknown[];
  failure?: string;
  cancelled?: boolean;
} {
  const turn = asRecord(asRecord(params)?.turn);
  const turnItems = turn?.items;
  const completedItems = (Array.isArray(turnItems) && turnItems.length > 0 ? turnItems : items).slice(-MAX_TURN_ITEMS);
  let finalResponse = "";
  for (const item of completedItems) {
    const record = asRecord(item);
    if (!record) continue;
    const type = record.type;
    if ((type === "agentMessage" || type === "agent_message") && typeof record.text === "string") {
      finalResponse = record.text;
    }
  }
  const status = turn?.status;
  const error = asRecord(turn?.error);
  const failure = status === "failed"
    ? directString(error?.message) ?? "Codex turn failed."
    : undefined;
  return { finalResponse, items: completedItems, failure, cancelled: status === "interrupted" || status === "cancelled" };
}

export function codexAppServerError(message: string, version?: string, stderr?: string): Error {
  return new Error([
    message,
    version ? `codex version: ${version}` : undefined,
    stderr?.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n"));
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || command.includes("\\") || /\.(?:cmd|bat|exe|com)$/i.test(command)) return [command];
  const path = env.PATH;
  if (!path) return [command];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return path.split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => resolve(directory, `${command}${extension}`)));
}

function usesWindowsCommandShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function turnMatchesEvent(turn: CodexTurnAccumulator, event: CodexEvent): boolean {
  const params = asRecord(event.params);
  const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const eventTurnId = typeof params?.turnId === "string"
    ? params.turnId
    : readString(asRecord(params?.turn), "id");
  if (eventThreadId && eventThreadId !== turn.threadId) return false;
  if (turn.turnId && eventTurnId && turn.turnId !== eventTurnId) return false;
  return eventThreadId === turn.threadId || Boolean(turn.turnId && eventTurnId === turn.turnId);
}

function codexUsage(
  input: LocalAgentRunInput,
  event: CodexEvent,
  sequence: number,
  final: boolean,
): LocalAgentUsageUpdate | undefined {
  if (event.method !== "thread/tokenUsage/updated") return undefined;
  const params = asRecord(event.params);
  const tokenUsage = asRecord(params?.tokenUsage ?? params?.token_usage);
  const usage = asRecord(tokenUsage?.last);
  if (!usage) return undefined;
  const outputTokens = readCount(usage, "outputTokens", "output_tokens");
  if (outputTokens === undefined) return undefined;
  return {
    attemptId: input.attemptId ?? "untracked",
    sequence,
    inputTokens: readCount(usage, "inputTokens", "input_tokens"),
    outputTokens,
    cacheReadTokens: readCount(usage, "cachedInputTokens", "cached_input_tokens"),
    cacheWriteTokens: readCount(usage, "cacheWriteInputTokens", "cache_write_input_tokens"),
    reasoningTokens: readCount(usage, "reasoningOutputTokens", "reasoning_output_tokens"),
    final,
  };
}

function codexProgress(event: CodexEvent): LocalAgentProgressUpdate | undefined {
  const params = asRecord(event.params);
  const item = asRecord(params?.item);
  if (event.method === "item/started" || event.method === "item/updated" || event.method === "item/completed") {
    const type = directString(item?.type);
    if (type === "agentMessage" || type === "agent_message") {
      const text = directString(item?.text);
      return text ? { type: "text", text: text.slice(0, 8 * 1024), final: event.method === "item/completed" } : undefined;
    }
    return {
      type: "tool",
      toolName: type ?? "tool",
      status: event.method === "item/started" ? "started" : event.method === "item/completed" ? "completed" : "updated",
    };
  }
  if (event.method === "item/agentMessage/delta") {
    const delta = directString(params?.delta);
    return delta ? { type: "text", text: delta.slice(0, 8 * 1024) } : undefined;
  }
  return undefined;
}

function parseJsonValue(text: string): LocalAgentRunResult["structuredOutput"] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonValue(value: unknown): value is Exclude<LocalAgentRunResult["structuredOutput"], undefined> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return Boolean(record && Object.getPrototypeOf(value) === Object.prototype && Object.values(record).every(isJsonValue));
}

function readCount(record: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = record[camel] ?? record[snake];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function protocolErrorText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return String(value);
  const message = directString(record.message);
  const code = record.code;
  return message ? `codex app-server${code === undefined ? "" : ` ${String(code)}`}: ${message}` : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTail(value: string, chunk: string, maxBytes: number): string {
  const next = value + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
