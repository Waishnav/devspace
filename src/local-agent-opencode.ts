import type {
  OpencodeClient,
  PermissionConfig,
} from "@opencode-ai/sdk/v2";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { startOpencodeServer, type OpencodeServerLike } from "./local-agent-opencode-server.js";
import {
  defaultOpencodeV2Factory,
  OpencodeV2Runtime,
  type OpencodeV2Factory,
} from "./local-agent-opencode-v2.js";
import {
  createOpenCodeRuntimeProbe,
  requireOpenCodeV1NativeSessionId,
  type OpenCodeRuntimeProbe,
} from "./local-agent-opencode-version.js";

const OPENCODE_PROMPT_TIMEOUT_MS = 5 * 60_000;

interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

export type OpencodeClientLike = Pick<OpencodeClient, "global" | "session">;

export type OpencodeFactory = (
  context?: LocalAgentRuntimeContext,
  env?: NodeJS.ProcessEnv,
) => Promise<{
  client: OpencodeClientLike;
  server: OpencodeServerLike;
}>;

export class OpencodeRuntime implements LocalAgentRuntime {
  readonly provider = "opencode" as const;
  private alive = true;
  private closed = false;
  private readonly promptControllers = new Set<AbortController>();

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly server: OpencodeServerLike,
    private readonly promptTimeoutMs = OPENCODE_PROMPT_TIMEOUT_MS,
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.alive) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "OpenCode runtime is not running.",
          });
        }
        try {
          await assertOpencodeHealthy(this.client);
          const sessionId = input.providerSessionId
            ? requireOpenCodeV1NativeSessionId(input.providerSessionId)
            : await createOpencodeSession(this.client, input);
          await callbacks?.onSessionId?.(sessionId);
          const promptResult = await this.prompt(sessionId, input);
          assertOpenCodePromptSucceeded(promptResult);
          const finalResponse = requireFinalResponse(extractOpenCodeFinalResponse(promptResult));
          return {
            provider: this.provider,
            providerSessionId: sessionId,
            finalResponse,
            items: [promptResult],
          };
        } catch (error) {
          if (isOpenCodeTransportFailure(error)) {
            this.alive = false;
            throw new AgentProviderUnavailableError({
              code: "PROVIDER_UNAVAILABLE",
              provider: this.provider,
              operation: "run",
              retryable: true,
              cause: error,
              message: "OpenCode provider is unavailable.",
            });
          }
          throw error;
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // OpenCode keeps durable sessions independently of this process.
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    for (const controller of this.promptControllers) controller.abort();
    this.promptControllers.clear();
    this.server.close();
  }

  private async prompt(sessionId: string, input: LocalAgentRunInput): Promise<unknown> {
    const controller = new AbortController();
    this.promptControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.promptTimeoutMs);
    try {
      return await promptOpencodeSession(this.client, sessionId, input, controller.signal);
    } catch (error) {
      if (!timedOut) throw error;
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: "opencode",
        operation: "prompt",
        retryable: true,
        cause: error,
        message: "OpenCode did not finish the prompt before the provider timeout.",
      });
    } finally {
      clearTimeout(timer);
      this.promptControllers.delete(controller);
    }
  }
}

export class OpencodeLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "opencode" as const;
  readonly providerInstanceId = "opencode";
  readonly idleTimeoutMs = 5 * 60_000;
  private readonly factory: OpencodeFactory;
  private readonly v2Factory: OpencodeV2Factory;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runtimeProbe: OpenCodeRuntimeProbe;

  constructor(options: {
    factory?: OpencodeFactory;
    v2Factory?: OpencodeV2Factory;
    env?: NodeJS.ProcessEnv;
    runtimeProbe?: OpenCodeRuntimeProbe;
  } = {}) {
    this.factory = options.factory ?? defaultOpencodeFactory;
    this.v2Factory = options.v2Factory ?? defaultOpencodeV2Factory;
    this.env = options.env ?? process.env;
    this.runtimeProbe = options.runtimeProbe ?? createOpenCodeRuntimeProbe(this.env);
  }

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    return "opencode:default";
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const runtime = await this.runtimeProbe.get();
        if (runtime.generation === "v2") {
          const { client, server } = await this.v2Factory(context, this.env);
          return new OpencodeV2Runtime(client, server);
        }
        const { client, server } = await this.factory(context, this.env);
        return new OpencodeRuntime(client, server);
      },
    });
  }
}

async function defaultOpencodeFactory(
  _context?: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ client: OpencodeClientLike; server: OpencodeServerLike }> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const config = {
    agent: {
      devspace_read_only: opencodeAgentConfig("read_only"),
      devspace_allowed: opencodeAgentConfig("allowed"),
      devspace_full_access: opencodeAgentConfig("full_access"),
    },
  };
  const server = await startOpencodeServer({
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  });
  return {
    client: createOpencodeClient({ baseUrl: server.url }),
    server,
  };
}

export function opencodeAgentConfig(writeMode: LocalAgentRunInput["writeMode"]): {
  mode: "primary";
  permission: PermissionConfig;
} {
  return {
    mode: "primary",
    permission: opencodePermissionFor(writeMode),
  };
}

async function createOpencodeSession(
  client: OpencodeClientLike,
  input: LocalAgentRunInput,
): Promise<string> {
  const result = await client.session.create({
    directory: input.workspaceRoot,
  }, { throwOnError: true });
  return requireSessionId(result.data);
}

export function opencodeAgentFor(writeMode: LocalAgentRunInput["writeMode"]): string {
  switch (writeMode) {
    case "read_only": return "devspace_read_only";
    case "full_access": return "devspace_full_access";
    case "allowed":
    case undefined: return "devspace_allowed";
  }
}

export function opencodePermissionFor(writeMode: LocalAgentRunInput["writeMode"]): PermissionConfig {
  const allowed = writeMode !== "read_only";
  const unrestricted = writeMode === "full_access";
  return {
    read: "allow",
    edit: allowed ? "allow" : "deny",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: allowed ? "allow" : "deny",
    task: "deny",
    external_directory: unrestricted ? "allow" : "deny",
  };
}

async function assertOpencodeHealthy(client: OpencodeClientLike): Promise<void> {
  try {
    await client.global.health({ throwOnError: true });
  } catch (error) {
    throw new OpencodeHealthError(errorMessage(error));
  }
}

function isOpenCodeTransportFailure(error: unknown): boolean {
  if (error instanceof OpencodeHealthError) return true;
  const code = transportErrorCode(error);
  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EPIPE"
    || code === "ENETDOWN"
    || code === "ENETUNREACH"
    || code === "ETIMEDOUT";
}

function transportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string") return code;
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause && typeof cause === "object" && typeof (cause as NodeJS.ErrnoException).code === "string"
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

class OpencodeHealthError extends Error {
  constructor(message: string) {
    super(`OpenCode server health check failed: ${message}`);
    this.name = "OpencodeHealthError";
  }
}

async function promptOpencodeSession(
  client: OpencodeClientLike,
  sessionId: string,
  input: LocalAgentRunInput,
  signal: AbortSignal,
): Promise<unknown> {
  const model = input.model ? parseOpencodeModel(input.model) : undefined;
  return client.session.prompt({
    sessionID: sessionId,
    directory: input.workspaceRoot,
    parts: [{ type: "text", text: input.prompt }],
    agent: opencodeAgentFor(input.writeMode),
    ...(model ? { model } : {}),
    ...(input.effort ? { variant: input.effort } : {}),
  }, { throwOnError: true, signal });
}

function parseOpencodeModel(model: string): OpencodeModelRef {
  const separator = model.indexOf("/");
  return separator === -1
    ? { providerID: "opencode", modelID: model }
    : { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function requireSessionId(session: unknown): string {
  const id = asRecord(session)?.id;
  if (typeof id !== "string" || !id) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "create_session",
      retryable: false,
      message: "OpenCode did not return a session id.",
    });
  }
  return id;
}

function assertOpenCodePromptSucceeded(value: unknown): void {
  const result = asRecord(unwrapProviderPayload(value));
  const info = asRecord(result?.info);
  const error = asRecord(info?.error);
  if (!error) return;
  const data = asRecord(error.data);
  const message = typeof data?.message === "string"
    ? data.message
    : typeof error.message === "string"
      ? error.message
      : typeof error.name === "string"
        ? `OpenCode returned ${error.name}.`
        : "OpenCode returned an assistant error.";
  throw new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "opencode",
    operation: "prompt",
    retryable: data?.isRetryable === true,
    cause: error,
    message,
  });
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";
  for (const key of ["content", "parts"] as const) {
    const parts = readArray(message, key);
    if (!parts) continue;
    const text = parts
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }
  const info = asRecord(message.info) ?? message;
  return stringifyStructuredMessage(info.structured);
}

function stringifyStructuredMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = asRecord(current);
    if (!record) return current;
    if (record.data !== undefined) {
      current = record.data;
      continue;
    }
    if (record.result !== undefined) {
      current = record.result;
      continue;
    }
    return current;
  }
  return current;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)?.[key];
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireFinalResponse(response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "run",
      retryable: false,
      message: "OpenCode did not return a final assistant response.",
    });
  }
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
