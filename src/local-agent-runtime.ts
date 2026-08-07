import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRuntime {
  readonly provider: string;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

// The Codex harness speaks the `codex app-server` JSON-RPC protocol over
// newline-delimited stdio: the client drives a thread (`thread/start` or
// `thread/resume`), runs one turn (`turn/start`), and observes streamed
// notifications until `turn/completed` reports the final item list.
export interface CodexAppServerInvocation {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: LocalAgentRunInput;
}

export interface CodexAppServerTurn {
  readonly threadId: string | null;
  readonly finalResponse: string;
  readonly items: unknown[];
}

export type CodexAppServerRunner = (
  invocation: CodexAppServerInvocation,
) => Promise<CodexAppServerTurn>;

export interface CodexAppServerRuntimeOptions {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly version?: string;
  readonly runner?: CodexAppServerRunner;
}

const CODEX_APPROVAL_POLICY = "never";

// Build the thread-opening request: a fresh `thread/start` unless the host
// supplied a provider session id, which resumes that thread in place.
export function codexAppServerThreadParams(input: LocalAgentRunInput): {
  method: "thread/start" | "thread/resume";
  params: Record<string, unknown>;
} {
  const sandbox = sandboxModeFor(input.writeMode);
  if (input.providerSessionId) {
    return {
      method: "thread/resume",
      params: {
        threadId: input.providerSessionId,
        cwd: input.workspace,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox,
        ...(input.model ? { model: input.model } : {}),
      },
    };
  }
  return {
    method: "thread/start",
    params: {
      cwd: input.workspace,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox,
      ...(input.model ? { model: input.model } : {}),
    },
  };
}

// Build the per-turn request against the opened thread. Reasoning effort is a
// free-form string passed through verbatim, matching the CLI's
// `model_reasoning_effort` override.
export function codexAppServerTurnParams(
  input: LocalAgentRunInput,
  threadId: string,
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandboxPolicy: turnSandboxPolicyFor(input.writeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { effort: input.thinking } : {}),
  };
}

export interface ParsedCodexAppServerEvents {
  threadId: string | null;
  finalResponse: string;
  items: unknown[];
  failure: unknown;
}

// Reduce the streamed notifications and the terminal `turn/completed` payload
// into the bounded-run result: the thread id, the final agent message, the
// item log, and any turn failure. `turn/completed` carries the authoritative
// item list for the turn; per-item notifications provide the thread id and
// the streaming fallback when that list is empty.
export function parseCodexAppServerEvents(
  events: Array<{ method: string; params?: unknown }>,
): ParsedCodexAppServerEvents {
  let threadId: string | null = null;
  let finalResponse = "";
  let items: unknown[] = [];
  let failure: unknown;
  for (const event of events) {
    switch (event.method) {
      case "thread/started": {
        const thread = asRecord(event.params)?.thread as Record<string, unknown> | undefined;
        if (thread && typeof thread.id === "string") threadId = thread.id;
        break;
      }
      case "item/completed": {
        const item = asRecord(asRecord(event.params)?.item);
        if (item) items.push(item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          finalResponse = item.text;
        }
        break;
      }
      case "turn/completed": {
        const params = asRecord(event.params);
        const turn = asRecord(params?.turn);
        if (turn?.status === "failed") {
          failure = failureMessage(asRecord(turn.error)?.message);
        }
        if (Array.isArray(turn?.items) && turn.items.length > 0) {
          items = turn.items;
        } else if (items.length === 0) {
          items = [];
        }
        for (const item of items) {
          if (finalResponse) break;
          const record = asRecord(item);
          if (record?.type === "agentMessage" && typeof record.text === "string") {
            finalResponse = record.text;
          }
        }
        break;
      }
    }
  }
  return { threadId, finalResponse, items, failure };
}

export class CodexAppServerLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly runner: CodexAppServerRunner;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.runner = options.runner ?? createCodexAppServerSpawnRunner({ version: options.version });
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const turn = await this.runner({
      command: this.options.command,
      env: this.options.env,
      input,
    });
    return {
      provider: this.provider,
      providerSessionId: turn.threadId,
      finalResponse: turn.finalResponse,
      items: turn.items,
    };
  }
}

export function createCodexAppServerLocalAgentRuntime(
  options: CodexAppServerRuntimeOptions,
): CodexAppServerLocalAgentRuntime {
  return new CodexAppServerLocalAgentRuntime(options);
}

interface CodexAppServerRpc {
  readonly events: Array<{ method: string; params?: unknown }>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  waitForNotification(
    predicate: (event: { method: string; params?: unknown }) => boolean,
  ): Promise<{ method: string; params?: unknown }>;
}

// The app-server wire is the transport boundary for the JSON-RPC protocol.
// The default spawn runner builds a wire over a live child; tests inject an
// in-memory peer to exercise the protocol offline.
export interface CodexAppServerWire {
  writeLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  endStdin(): void;
}

// Drive the host `codex app-server` over a wire and eventually through one
// bounded turn. The wire is injected so the protocol can be exercised offline
// against an in-memory peer (or a live child for the default spawn runner).
export async function runCodexAppServerTurn(
  wire: CodexAppServerWire,
  input: LocalAgentRunInput,
): Promise<CodexAppServerTurn> {
  const rpc = attachCodexAppServerRpc(wire);
  await initializeCodexAppServer(rpc);
  const threadId = await openCodexThread(rpc, input);
  await rpc.request("turn/start", codexAppServerTurnParams(input, threadId));
  await waitForTurnCompleted(rpc);
  const parsed = parseCodexAppServerEvents([...rpc.events]);
  if (parsed.failure) {
    throw new Error(`codex turn failed: ${String(parsed.failure)}`);
  }
  return {
    threadId: parsed.threadId ?? threadId,
    finalResponse: parsed.finalResponse,
    items: parsed.items,
  };
}

export function createCodexAppServerSpawnRunner(options: {
  version?: string;
} = {}): CodexAppServerRunner {
  const version = options.version;
  return async (invocation) => {
    const { command, env, input } = invocation;
    const child = spawn(command, ["app-server"], {
      env,
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    let stderr = "";
    child.once("error", (error) => {
      spawnError = error;
    });
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }
    const wire: CodexAppServerWire = {
      onLine: (handler) => {
        if (!child.stdout) {
          throw new Error("codex app-server did not expose stdout.");
        }
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", handler);
      },
      onExit: (handler) => {
        child.once("exit", (code, signal) => handler(code, signal));
      },
      endStdin: () => {
        try {
          if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        } catch {
          // The process may already be gone.
        }
      },
      writeLine: (line) => {
        if (!child.stdin) {
          throw new Error("codex app-server did not expose stdin.");
        }
        child.stdin.write(`${line}\n`);
      },
    };
    try {
      const turn = await runCodexAppServerTurn(wire, input);
      return turn;
    } catch (error) {
      if (spawnError) {
        throw codexAppServerError(
          `Failed to start codex app-server: ${spawnError.message}`,
          version,
          stderr,
        );
      }
      if (error instanceof CodexAppServerError) {
        throw error;
      }
      throw codexAppServerError(errorMessage(error), version, stderr);
    } finally {
      await terminateWire(wire);
    }
  };
}

async function initializeCodexAppServer(rpc: CodexAppServerRpc): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: {
      name: "devspace",
      title: "DevSpace",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  rpc.notify("initialized");
}

async function openCodexThread(
  rpc: CodexAppServerRpc,
  input: LocalAgentRunInput,
): Promise<string> {
  const params = codexAppServerThreadParams(input);
  const response = asRecord(await rpc.request(params.method, params.params));
  const thread = asRecord(response?.thread);
  const threadId = thread && typeof thread.id === "string" ? thread.id : undefined;
  if (!threadId) {
    throw new Error(`codex app-server did not return a thread id for ${params.method}.`);
  }
  return threadId;
}

function attachCodexAppServerRpc(
  wire: CodexAppServerWire,
): CodexAppServerRpc {
  let nextRequestId = 1;
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const waiters: Array<{
    predicate: (event: { method: string; params?: unknown }) => boolean;
    resolve: (event: { method: string; params?: unknown }) => void;
    reject: (error: Error) => void;
  }> = [];
  const events: Array<{ method: string; params?: unknown }> = [];
  let fatalError: Error | undefined;

  const dispatch = (event: { method: string; params?: unknown }): void => {
    events.push(event);
    for (const waiter of waiters) {
      if (waiter.predicate(event)) {
        waiter.resolve(event);
        waiters.splice(waiters.indexOf(waiter), 1);
        return;
      }
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "string" ? message.id : undefined;
    if (id !== undefined && method === undefined) {
      const pendingEntry = id ? pending.get(id) : undefined;
      if (!pendingEntry) return;
      pending.delete(id);
      if (message.error !== undefined) {
        pendingEntry.reject(new Error(protocolErrorText(message.error)));
        return;
      }
      pendingEntry.resolve(message.result);
      return;
    }
    if (id !== undefined && method !== undefined) {
      // The app-server can request approvals or user input mid-turn. DevSpace
      // runs bounded non-interactive turns, so decline anything that asks.
      wire.writeLine(JSON.stringify({
        id,
        error: { code: -32601, message: `unsupported app-server request: ${method}` },
      }));
      return;
    }
    if (method !== undefined) {
      dispatch({ method, params: message.params });
    }
  };

  wire.onLine(handleLine);
  wire.onExit((code, signal) => {
    if (fatalError) return;
    fatalError = new Error(
      `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`} before the turn completed`,
    );
    for (const entry of pending.values()) {
      entry.reject(fatalError);
    }
    for (const waiter of waiters) {
      waiter.reject(fatalError);
    }
    pending.clear();
    waiters.length = 0;
  });

  return {
    events,
    request(method, params) {
      if (fatalError) return Promise.reject(fatalError);
      const id = String(nextRequestId);
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        wire.writeLine(JSON.stringify({
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }));
      });
    },
    notify(method, params) {
      wire.writeLine(JSON.stringify({
        method,
        ...(params !== undefined ? { params } : {}),
      }));
    },
    waitForNotification(predicate) {
      if (fatalError) return Promise.reject(fatalError);
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve, reject });
      });
    },
  };
}

function waitForTurnCompleted(
  rpc: CodexAppServerRpc,
): Promise<{ method: string; params?: unknown }> {
  return rpc.waitForNotification((event) => {
    if (event.method !== "turn/completed") return false;
    const turn = asRecord(asRecord(event.params)?.turn);
    return turn?.status !== undefined;
  });
}

function protocolErrorText(error: unknown): string {
  const record = asRecord(error);
  if (!record) return String(error);
  const message = record.message;
  const code = record.code;
  if (typeof message === "string") {
    return typeof code === "string" || typeof code === "number"
      ? `codex app-server ${code}: ${message}`
      : message;
  }
  return String(error);
}

async function terminateWire(wire: CodexAppServerWire): Promise<void> {
  try {
    wire.endStdin();
  } catch {
    // The process may already be gone.
  }
}

// Surface the CLI version and raw stderr in the exception so the session error
// row lets the host reason about model gates without forensics.
export class CodexAppServerError extends Error {}

export function codexAppServerError(
  message: string,
  version?: string,
  stderr?: string,
): CodexAppServerError {
  const details = [
    message,
    version ? `codex version: ${version}` : undefined,
    stderr && stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n");
  return new CodexAppServerError(details);
}

export function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function turnSandboxPolicyFor(
  writeMode: LocalAgentWriteMode | undefined,
): { type: "readOnly" | "workspaceWrite" | "dangerFullAccess" } {
  switch (writeMode) {
    case "allowed":
      return { type: "workspaceWrite" };
    case "full_access":
      return { type: "dangerFullAccess" };
    case "read_only":
    case undefined:
      return { type: "readOnly" };
  }
}

function failureMessage(error: unknown): unknown {
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return unwrapErrorMessage(message);
    }
  }
  if (typeof error === "string" && error.trim()) return unwrapErrorMessage(error);
  return error;
}

// The CLI can surface `turn.error.message` as a JSON-encoded error payload
// (e.g. provider HTTP errors); peel down to the innermost human-readable
// message so the session error row stays legible.
function unwrapErrorMessage(message: string): string {
  if (!message.startsWith("{") && !message.startsWith("[")) return message;
  for (let depth = 0; depth < 3; depth += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      return message;
    }
    const current = asRecord(parsed);
    if (!current) return message;
    const inner = current.message ?? current.error;
    if (typeof inner === "string" && inner.trim()) return inner;
    const innerRecord = asRecord(inner);
    if (typeof innerRecord?.message === "string" && innerRecord.message.trim()) {
      message = innerRecord.message;
      continue;
    }
    if (typeof innerRecord?.error === "string" && innerRecord.error.trim()) {
      message = innerRecord.error;
      continue;
    }
    return message;
  }
  return message;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
