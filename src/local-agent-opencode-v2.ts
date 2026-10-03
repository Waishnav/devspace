import { randomBytes } from "node:crypto";
import {
  OpenCode,
  type ModelRef,
  type OpenCodeClient,
  type PermissionRule,
  type SessionMessageAssistant,
} from "@opencode/client";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import { localAgentMcpLaunch } from "./local-agent-mcp-launch.js";
import type {
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { startOpencodeServer, type OpencodeServerLike } from "./local-agent-opencode-server.js";
import {
  encodeOpenCodeV2SessionId,
  requireOpenCodeV2NativeSessionId,
} from "./local-agent-opencode-version.js";

const OPENCODE_PROMPT_TIMEOUT_MS = 5 * 60_000;

export type OpencodeV2ClientLike = Pick<OpenCodeClient, "server" | "session" | "message" | "model"> & {
  mcp?: Pick<OpenCodeClient["mcp"], "add">;
};

export type OpencodeV2Factory = (
  context?: LocalAgentRuntimeContext,
  env?: NodeJS.ProcessEnv,
) => Promise<{
  client: OpencodeV2ClientLike;
  server: OpencodeServerLike;
}>;

export class OpencodeV2Runtime implements LocalAgentRuntime {
  readonly provider = "opencode" as const;
  private alive = true;
  private closed = false;
  private readonly promptControllers = new Set<AbortController>();

  constructor(
    private readonly client: OpencodeV2ClientLike,
    private readonly server: OpencodeServerLike,
    private readonly env: NodeJS.ProcessEnv = process.env,
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
          await configureOpenCodeV2Mcp(this.client, input, this.env);
          await this.client.server.info();
          const continuing = input.providerSessionId !== undefined;
          const nativeSessionId = input.providerSessionId
            ? requireOpenCodeV2NativeSessionId(input.providerSessionId)
            : await this.createSession(input);
          const providerSessionId = encodeOpenCodeV2SessionId(nativeSessionId);
          await callbacks?.onSessionId?.(providerSessionId);
          if (continuing) await this.configureSession(nativeSessionId, input);
          const messages = await this.prompt(nativeSessionId, input);
          const assistant = requireLatestAssistant(messages.data);
          assertOpenCodeV2AssistantSucceeded(assistant);
          return {
            provider: this.provider,
            providerSessionId,
            finalResponse: requireOpenCodeV2FinalResponse(assistant),
            items: messages.data,
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

  private async createSession(input: LocalAgentRunInput): Promise<string> {
    const model = await resolveOpenCodeV2Model(this.client, input);
    const session = await this.client.session.create({
      location: { directory: input.workspaceRoot },
      permissions: opencodeV2Permissions(input.writeMode),
      ...(model ? { model } : {}),
    });
    if (!session.id) {
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

  private async configureSession(sessionId: string, input: LocalAgentRunInput): Promise<void> {
    await this.client.session.update({
      sessionID: sessionId,
      permissions: opencodeV2Permissions(input.writeMode),
    });
    if (!input.model && !input.effort) return;
    const current = await this.client.session.get({ sessionID: sessionId });
    const model = await resolveOpenCodeV2Model(this.client, input, current.model);
    if (!model) return;
    await this.client.session.switchModel({ sessionID: sessionId, model });
  }

  private async prompt(sessionId: string, input: LocalAgentRunInput) {
    const controller = new AbortController();
    this.promptControllers.add(controller);
    let timedOut = false;
    const removeAbort = bindLocalAgentAbort(input.signal, async () => {
      await this.client.session.interrupt({ sessionID: sessionId });
      controller.abort();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.promptTimeoutMs);
    try {
      await this.client.session.prompt({
        sessionID: sessionId,
        text: input.prompt,
      }, { signal: controller.signal });
      await this.client.session.wait({ sessionID: sessionId }, { signal: controller.signal });
      return await this.client.message.list({
        sessionID: sessionId,
        limit: 1,
        order: "desc",
        type: "assistant",
      }, { signal: controller.signal });
    } catch (error) {
      if (input.signal?.aborted) throw localAgentCancelledError("opencode", "prompt", error);
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

export async function defaultOpencodeV2Factory(
  _context?: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ client: OpencodeV2ClientLike; server: OpencodeServerLike }> {
  const password = randomBytes(32).toString("base64url");
  const server = await startOpencodeServer(opencodeV2ServerEnvironment(env, password));
  const authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  return {
    client: OpenCode.make({
      baseUrl: server.url,
      headers: { authorization },
    }),
    server,
  };
}

export function opencodeV2ServerEnvironment(
  env: NodeJS.ProcessEnv,
  password: string,
): NodeJS.ProcessEnv {
  const {
    OPENCODE_PASSWORD: _opencodePassword,
    OPENCODE_SERVER_PASSWORD: _legacyPassword,
    ...rest
  } = env;
  return { ...rest, OPENCODE_PASSWORD: password };
}

export async function configureOpenCodeV2Mcp(
  client: OpencodeV2ClientLike,
  input: LocalAgentRunInput,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const mcp = localAgentMcpLaunch(input, env);
  if (!mcp || !client.mcp) return;
  await client.mcp.add({
    server: mcp.name,
    location: { directory: input.workspaceRoot },
    config: {
      type: "local",
      command: [mcp.command, ...mcp.args],
      cwd: input.workspaceRoot,
      environment: mcp.env,
      protocol: "auto",
    },
  });
}

export function opencodeV2Permissions(
  writeMode: LocalAgentRunInput["writeMode"],
): PermissionRule[] {
  const rules: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: "deny" },
  ];
  if (writeMode !== "full_access") {
    rules.push({ action: "external_directory", resource: "*", effect: "deny" });
  }
  if (writeMode === "read_only") {
    rules.push(
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    );
  }
  return rules;
}

async function resolveOpenCodeV2Model(
  client: OpencodeV2ClientLike,
  input: LocalAgentRunInput,
  current?: ModelRef,
): Promise<ModelRef | undefined> {
  if (input.model) return parseOpenCodeV2Model(input.model, input.effort);
  if (!input.effort) return undefined;
  if (current) return { ...current, variant: input.effort };
  const fallback = await client.model.default({
    location: { directory: input.workspaceRoot },
  });
  if (!fallback.data) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "select_model",
      retryable: false,
      message: "OpenCode has no default model to apply the requested effort variant to.",
    });
  }
  return {
    id: fallback.data.id,
    providerID: fallback.data.providerID,
    variant: input.effort,
  };
}

export function parseOpenCodeV2Model(model: string, effort?: string): ModelRef {
  const separator = model.indexOf("/");
  return {
    providerID: separator === -1 ? "opencode" : model.slice(0, separator),
    id: separator === -1 ? model : model.slice(separator + 1),
    ...(effort ? { variant: effort } : {}),
  };
}

export function extractOpenCodeV2FinalResponse(message: SessionMessageAssistant): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function requireOpenCodeV2FinalResponse(message: SessionMessageAssistant): string {
  const response = extractOpenCodeV2FinalResponse(message);
  if (!response) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "run",
      retryable: false,
      message: "OpenCode did not return a final assistant response.",
    });
  }
  return response;
}

function requireLatestAssistant(messages: unknown[]): SessionMessageAssistant {
  const assistant = messages.find((message) => (
    message !== null
    && typeof message === "object"
    && "type" in message
    && message.type === "assistant"
  ));
  if (!assistant) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "run",
      retryable: false,
      message: "OpenCode did not return an assistant message after the prompt completed.",
    });
  }
  return assistant as SessionMessageAssistant;
}

function assertOpenCodeV2AssistantSucceeded(message: SessionMessageAssistant): void {
  if (!message.error) return;
  throw new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "opencode",
    operation: "prompt",
    retryable: message.error.status === 429 || (message.error.status ?? 0) >= 500,
    cause: message.error,
    message: message.error.message || `OpenCode returned ${message.error.type}.`,
  });
}

function isOpenCodeTransportFailure(error: unknown): boolean {
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
