import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import type {
  AssistantMessage,
  OpencodeClient,
} from "@opencode-ai/sdk/v2";
import { z, type JSONType } from "zod";
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
import { terminateProcessTree } from "./process-platform.js";

const OPENCODE_SERVER_HOSTNAME = "127.0.0.1";

const OPENCODE_SERVER_START_TIMEOUT_MS = 5_000;

const OPENCODE_SERVER_START_ATTEMPTS = 3;

const OPENCODE_PROMPT_TIMEOUT_MS = 5 * 60_000;

const require = createRequire(import.meta.url);

const spawn: typeof import("node:child_process").spawn = require("cross-spawn");

interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

type OpencodePermissionAction = "allow" | "deny";

interface OpencodePermissionConfig {
  read: OpencodePermissionAction;
  edit: OpencodePermissionAction;
  glob: OpencodePermissionAction;
  grep: OpencodePermissionAction;
  list: OpencodePermissionAction;
  bash: OpencodePermissionAction;
  task: OpencodePermissionAction;
  external_directory: OpencodePermissionAction;
}

interface OpencodeAgentSettings {
  mode: "primary";
  permission: OpencodePermissionConfig;
}

interface OpencodeServerConfig {
  agent: {
    devspace_read_only: OpencodeAgentSettings;
    devspace_allowed: OpencodeAgentSettings;
    devspace_full_access: OpencodeAgentSettings;
  };
}

interface OpencodePromptData {
  info: {
    role: string;
    error?: AssistantMessage["error"];
    structured?: JSONType;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface OpencodePromptRequest {
  sessionID: string;
  directory: string;
  parts: Array<{ type: "text"; text: string }>;
  agent: string;
  model?: OpencodeModelRef;
  variant?: string;
}

const opencodeAddressSchema = z.object({ port: z.number() });

const transportErrorSchema = z.object({
  code: z.string().optional(),
  cause: z.object({ code: z.string().optional() }).optional(),
});

const providerWrapperSchema = z.object({
  data: z.json().optional(),
  result: z.json().optional(),
});

const providerMessageCollectionSchema = z.object({
  messages: z.array(z.json()),
});

const providerMessageSchema = z.object({
  role: z.string().optional(),
  type: z.string().optional(),
  info: z.object({
    role: z.string().optional(),
    structured: z.json().optional(),
  }).optional(),
  content: z.array(z.json()).optional(),
  parts: z.array(z.json()).optional(),
  structured: z.json().optional(),
});

const providerTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

interface OpencodeRequestOptions {
  signal?: AbortSignal;
}

export interface OpencodeClientLike {
  global: {
    health(): Promise<void>;
  };
  session: {
    create(
      input: { directory: string },
    ): Promise<{ data?: { id: string } }>;
    prompt(
      input: OpencodePromptRequest,
      options?: OpencodeRequestOptions,
    ): Promise<{ data: OpencodePromptData }>;
  };
}

export interface OpencodeServerLike {
  close(): void;
}

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
          const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input);
          await callbacks?.onSessionId?.(sessionId);
          const promptResult = await this.prompt(sessionId, input);
          assertOpenCodePromptSucceeded(promptResult);
          const finalResponse = requireFinalResponse(extractTypedOpenCodeFinalResponse(promptResult));

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

  private async prompt(sessionId: string, input: LocalAgentRunInput): Promise<OpencodePromptData> {
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
  readonly idleTimeoutMs = 5 * 60_000;

  constructor(
    private readonly factory: OpencodeFactory = defaultOpencodeFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    return "opencode:default";
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
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

  const server = await startOpencodeServer(env, config);
  const sdkClient = createOpencodeClient({ baseUrl: server.url });

  return {
    client: wrapOpencodeClient(sdkClient),
    server,
  };
}

function wrapOpencodeClient(sdkClient: OpencodeClient): OpencodeClientLike {
  return {
    global: {
      health: async (): Promise<void> => {
        await sdkClient.global.health({ throwOnError: true });
      },
    },
    session: {
      create: async (input) => {
        const result = await sdkClient.session.create(input, { throwOnError: true });

        return { data: result.data ? { id: result.data.id } : undefined };
      },
      prompt: async (input, options) => {
        const result = await sdkClient.session.prompt(input, {
          ...options,
          throwOnError: true,
        });

        const structured = z.json().safeParse(result.data.info.structured);

        return {
          data: {
            info: {
              role: result.data.info.role,
              error: result.data.info.error,
              structured: structured.success ? structured.data : undefined,
            },
            parts: result.data.parts.map((part) => part.type === "text"
              ? { type: part.type, text: part.text }
              : { type: part.type }),
          },
        };
      },
    },
  };
}

async function startOpencodeServer(
  env: NodeJS.ProcessEnv,
  config: OpencodeServerConfig,
): Promise<OpencodeServerLike & { url: string }> {
  for (let attempt = 1; attempt <= OPENCODE_SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await allocateOpencodePort();

    try {
      return await launchOpencodeServer(env, config, port);
    } catch (error) {
      if (attempt === OPENCODE_SERVER_START_ATTEMPTS || !await isOpencodePortInUse(port)) throw error;
    }
  }

  throw new Error("OpenCode server failed to start.");
}

async function launchOpencodeServer(
  env: NodeJS.ProcessEnv,
  config: OpencodeServerConfig,
  port: number,
): Promise<OpencodeServerLike & { url: string }> {
  const detached = process.platform !== "win32";

  const child = spawn("opencode", [
    "serve",
    `--hostname=${OPENCODE_SERVER_HOSTNAME}`,
    `--port=${port}`,
  ], {
    detached,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    terminateProcessTree(child, "SIGTERM", detached);
  };

  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    let ready = false;

    const timer = setTimeout(() => {
      if (ready) return;
      close();
      reject(new Error(`Timeout waiting for OpenCode server after ${OPENCODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPENCODE_SERVER_START_TIMEOUT_MS);

    timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (ready) return;
      output += chunk.toString();

      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);

        if (!match?.[1]) continue;
        ready = true;
        clearTimeout(timer);
        resolve(match[1]);

        return;
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!ready) output += chunk.toString();
    });
    child.once("error", (error) => {
      if (ready) return;
      clearTimeout(timer);
      close();
      reject(error);
    });
    child.once("exit", (code) => {
      if (ready) return;
      clearTimeout(timer);
      close();
      reject(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output.trim()}` : ""}`));
    });
  });

  return { url, close };
}

async function allocateOpencodePort(): Promise<number> {
  const server = createNetServer();
  server.unref();

  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: OPENCODE_SERVER_HOSTNAME, port: 0, exclusive: true }, () => {
      const address = server.address();
      const parsedAddress = opencodeAddressSchema.safeParse(address);

      if (!parsedAddress.success) {
        server.close();
        reject(new Error("Failed to allocate an OpenCode server port."));

        return;
      }

      server.close((error) => error ? reject(error) : resolve(parsedAddress.data.port));
    });
  });
}

async function isOpencodePortInUse(port: number): Promise<boolean> {
  const server = createNetServer();
  server.unref();

  return new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else reject(error);
    });
    server.listen({ host: OPENCODE_SERVER_HOSTNAME, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(false));
    });
  });
}

export function opencodeAgentConfig(writeMode: LocalAgentRunInput["writeMode"]): OpencodeAgentSettings {
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
  });

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

export function opencodePermissionFor(writeMode: LocalAgentRunInput["writeMode"]): OpencodePermissionConfig {
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
    await client.global.health();
  } catch (error) {
    throw new OpencodeHealthError(errorMessage(error));
  }
}

function isOpenCodeTransportFailure(cause: unknown): boolean {
  if (cause instanceof OpencodeHealthError) return true;
  const code = transportErrorCode(cause);

  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EPIPE"
    || code === "ENETDOWN"
    || code === "ENETUNREACH"
    || code === "ETIMEDOUT";
}

function transportErrorCode(cause: unknown): string | undefined {
  const parsed = transportErrorSchema.safeParse(cause);

  if (!parsed.success) return undefined;

  return parsed.data.code ?? parsed.data.cause?.code;
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
): Promise<OpencodePromptData> {
  const model = input.model ? parseOpencodeModel(input.model) : undefined;

  const request: OpencodePromptRequest = {
    sessionID: sessionId,
    directory: input.workspaceRoot,
    parts: [{ type: "text", text: input.prompt }],
    agent: opencodeAgentFor(input.writeMode),
  };

  if (model) request.model = model;

  if (input.effort) request.variant = input.effort;

  const result = await client.session.prompt(request, { signal });

  return result.data;
}

function parseOpencodeModel(model: string): OpencodeModelRef {
  const separator = model.indexOf("/");

  return separator === -1
    ? { providerID: "opencode", modelID: model }
    : { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function requireSessionId(session: { id: string } | undefined): string {
  if (!session?.id) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "create_session",
      retryable: false,
      message: "OpenCode did not return a session id.",
    });
  }

  return session.id;
}

function assertOpenCodePromptSucceeded(value: OpencodePromptData): void {
  const error = value.info.error;

  if (!error) return;

  throw new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "opencode",
    operation: "prompt",
    retryable: error.name === "APIError" && error.data.isRetryable,
    cause: error,
    message: opencodeAssistantErrorMessage(error),
  });
}

function opencodeAssistantErrorMessage(error: NonNullable<AssistantMessage["error"]>): string {
  const message = z.object({ message: z.string() }).safeParse(error.data);

  if (message.success) return message.data.message;

  if (error.name === "MessageOutputLengthError") {
    return "OpenCode returned MessageOutputLengthError.";
  }

  return `OpenCode returned ${error.name}.`;
}

function extractTypedOpenCodeFinalResponse(value: OpencodePromptData): string {
  const text = value.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("")
    .trim();

  if (text) return text;
  const structured = z.json().safeParse(value.info.structured);

  return structured.success ? stringifyStructuredMessage(structured.data) : "";
}

export function extractOpenCodeFinalResponse(value: JSONType): string {
  const root = unwrapProviderPayload(value);
  const collection = providerMessageCollectionSchema.safeParse(root);

  const messages = Array.isArray(root)
    ? root
    : collection.success
      ? collection.data.messages
      : undefined;

  if (messages) return extractLastOpenCodeAssistantMessageText(messages);

  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: JSONType[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = providerMessageSchema.safeParse(messages[index]);

    if (!parsed.success) continue;
    const message = parsed.data;
    const role = message.info?.role ?? message.role;
    const type = message.type;

    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(messages[index]);

    if (text) return text;
  }

  return "";
}

function extractOpenCodeAssistantMessageText(value: JSONType): string {
  const parsed = providerMessageSchema.safeParse(value);

  if (!parsed.success) return "";
  const message = parsed.data;

  for (const parts of [message.content, message.parts]) {

    if (!parts) continue;

    const text = parts
      .flatMap((part) => {
        const parsedPart = providerTextPartSchema.safeParse(part);

        return parsedPart.success ? [parsedPart.data.text] : [];
      })
      .join("");

    if (text.trim()) return text.trim();
  }

  const structured = message.info?.structured ?? message.structured;

  return stringifyStructuredMessage(structured);
}

function stringifyStructuredMessage(value: JSONType | undefined): string {
  if (value === undefined || value === null) return "";
  const text = z.string().safeParse(value);

  if (text.success) return text.data.trim();

  return JSON.stringify(value) ?? "";
}

function unwrapProviderPayload(value: JSONType): JSONType {
  let current = value;

  for (let depth = 0; depth < 3; depth += 1) {
    const parsed = providerWrapperSchema.safeParse(current);

    if (!parsed.success) return current;

    if (parsed.data.data !== undefined) {
      current = parsed.data.data;
      continue;
    }

    if (parsed.data.result !== undefined) {
      current = parsed.data.result;
      continue;
    }

    return current;
  }

  return current;
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
