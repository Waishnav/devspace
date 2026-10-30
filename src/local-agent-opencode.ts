import { isObjectValue, isJsonString, optionalFields } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import type { WireInput, JsonObject } from "./json-value.js";
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
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentModel,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { startOpencodeServer, type OpencodeServerLike } from "./local-agent-opencode-server.js";
import {
  defaultOpencodeV2Factory,
  OpencodeV2Runtime,
  type OpencodeV2Factory,
} from "./local-agent-opencode-v2.js";
import {
  probeOpenCodeBinary,
  runOpenCodeModels,
  requireOpenCodeV1NativeSessionId,
  type OpenCodeRuntimeProbeFunction,
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
          // OpenCode does not stream activity to DevSpace; report the reply once the turn ends.
          callbacks?.onEvent?.({ type: "message", text: finalResponse });

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

  private async prompt(sessionId: string, input: LocalAgentRunInput): Promise<WireInput> {
    const controller = new AbortController();
    this.promptControllers.add(controller);
    let timedOut = false;

    // End the local request only once OpenCode confirms the abort. A failed or
    // stalled abort keeps the turn running, and the manager reports the stop as a conflict.
    const removeAbort = bindLocalAgentAbort(input.signal, async () => {
      const aborted = await this.client.session.abort({
        sessionID: sessionId,
        directory: input.workspaceRoot,
      }, { throwOnError: false });

      if (!aborted.error) controller.abort();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.promptTimeoutMs);

    try {
      return await promptOpencodeSession(this.client, sessionId, input, controller.signal);
    } catch (error) {
      // A provider timeout after a stop request is still a timeout: the abort was never confirmed.
      if (input.signal?.aborted && !timedOut) throw localAgentCancelledError("opencode", "prompt", error);

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
      removeAbort();
      this.promptControllers.delete(controller);
    }
  }
}

export class OpencodeLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "opencode" as const;
  readonly providerInstanceId = "opencode";
  readonly runtimePolicy = { scope: "instance", idleTimeoutMs: 5 * 60_000 } as const;
  readonly capabilities = {
    sessions: { resume: true, close: false },
    turns: { interrupt: true, streaming: false },
    configuration: { modelOverride: true, effortOverride: true },
    permissions: { enforcement: "native" },
    mcp: { supported: true },
  } as const;
  private readonly factory: OpencodeFactory;
  private readonly v2Factory: OpencodeV2Factory;
  private readonly env: NodeJS.ProcessEnv;
  private readonly probeRuntime: OpenCodeRuntimeProbeFunction;

  constructor(options: {
    factory?: OpencodeFactory;
    v2Factory?: OpencodeV2Factory;
    env?: NodeJS.ProcessEnv;
    probeRuntime?: OpenCodeRuntimeProbeFunction;
  } = {}) {
    this.factory = options.factory ?? defaultOpencodeFactory;
    this.v2Factory = options.v2Factory ?? defaultOpencodeV2Factory;
    this.env = options.env ?? process.env;
    this.probeRuntime = options.probeRuntime ?? (() => probeOpenCodeBinary(this.env));
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        // Probe on every runtime creation so an upgraded executable is routed to the matching protocol generation.
        const runtime = await this.probeRuntime();

        if (runtime.generation === "v2") {
          const { client, server } = await this.v2Factory(context, this.env);

          return new OpencodeV2Runtime(client, server);
        }

        const { client, server } = await this.factory(context, this.env);

        return new OpencodeRuntime(client, server);
      },
    });
  }

  /** `opencode models` prints the same `provider/model` ids `--model` accepts, on both protocol generations. */
  async listModels(workspaceRoot: string) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "list_models",
      run: async () => {
        return opencodeModelsFromCli(await runOpenCodeModels(this.env, workspaceRoot));
      },
    });
  }
}

export function opencodeModelsFromCli(stdout: string): LocalAgentModel[] {
  return stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[^\s/]+\/\S+$/.test(line))
    .map((id) => ({ id }));
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

export function opencodeAgentConfig(writeMode: LocalAgentRunInput["writeMode"]) {
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

function isOpenCodeTransportFailure(error: WireInput): boolean {
  if (error instanceof OpencodeHealthError) return true;
  const code = transportErrorCode(error);

  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EPIPE"
    || code === "ENETDOWN"
    || code === "ENETUNREACH"
    || code === "ETIMEDOUT";
}

function transportErrorCode(error: WireInput): string | undefined {
  if (!error || !isObjectValue(error)) return undefined;
  // SAFETY: The surrounding checks or construction already match this type.
  const code = (error as NodeJS.ErrnoException).code;

  if (isJsonString(code)) return code;
  // SAFETY: The surrounding checks or construction already match this type.
  const cause = (error as Error & { cause?: unknown }).cause;

  // SAFETY: The surrounding checks or construction already match this type.
  return cause && isObjectValue(cause) && isJsonString((cause as NodeJS.ErrnoException).code)
    // SAFETY: The surrounding checks or construction already match this type.
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
): Promise<WireInput> {
  const model = input.model ? parseOpencodeModel(input.model) : undefined;

  return client.session.prompt({
    sessionID: sessionId,
    directory: input.workspaceRoot,
    parts: [{ type: "text", text: input.prompt }],
    agent: opencodeAgentFor(input.writeMode),
    ...optionalFields(model ? { model } : undefined),
    ...optionalFields(input.effort ? { variant: input.effort } : undefined),
  }, { throwOnError: true, signal });
}

function parseOpencodeModel(model: string): OpencodeModelRef {
  const separator = model.indexOf("/");

  return separator === -1
    ? { providerID: "opencode", modelID: model }
    : { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function requireSessionId(session: WireInput): string {
  const id = asRecord(session)?.id;

  if (!isJsonString(id) || !id) {
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

function assertOpenCodePromptSucceeded(value: WireInput): void {
  const result = asRecord(unwrapProviderPayload(value));
  const info = asRecord(result?.info);
  const error = asRecord(info?.error);

  if (!error) return;
  const data = asRecord(error.data);

  const message = isJsonString(data?.message)
    ? data.message
    : isJsonString(error.message)
      ? error.message
      : isJsonString(error.name)
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

export function extractOpenCodeFinalResponse(value: WireInput): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");

  if (messages) return extractLastOpenCodeAssistantMessageText(messages);

  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: WireInput[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);

    if (!message) continue;
    const info = asRecord(message.info);
    const role = isJsonString(info?.role) ? info.role : message.role;
    const type = isJsonString(message.type) ? message.type : undefined;

    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);

    if (text) return text;
  }

  return "";
}

function extractOpenCodeAssistantMessageText(value: WireInput): string {
  const message = asRecord(value);

  if (!message) return "";

  for (const key of ["content", "parts"] as const) {
    const parts = readArray(message, key);

    if (!parts) continue;

    const text = parts
      .map((part) => {
        const record = asRecord(part);

        return record?.type === "text" && isJsonString(record.text) ? record.text : "";
      })
      .filter(Boolean)
      .join("");

    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;

  return stringifyStructuredMessage(info.structured);
}

function stringifyStructuredMessage(value: WireInput): string {
  if (value === undefined || value === null) return "";

  if (isJsonString(value)) return value.trim();

  return JSON.stringify(value);
}

function unwrapProviderPayload(value: WireInput): WireInput {
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

function readArray(value: WireInput, key: string): WireInput[] | undefined {
  const result = asRecord(value)?.[key];

  return Array.isArray(result) ? result : undefined;
}

function asRecord(value: WireInput): JsonObject | undefined {
  return value !== null && isObjectValue(value) && !Array.isArray(value)
    // SAFETY: The surrounding checks or construction already match this type.
    ? unsafeNarrow<JsonObject>(value)
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

function errorMessage(error: WireInput): string {
  return error instanceof Error ? error.message : String(error);
}
