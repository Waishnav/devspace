import { randomBytes } from "node:crypto";
import {
  ClientError,
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
import type {
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { startOpencodeServer, type OpencodeServerLike } from "./local-agent-opencode-server.js";
import { optionalFields, isJsonObject } from "./json-value.js";
import type { JsonValue } from "./json-value.js";
import {
  encodeOpenCodeV2SessionId,
  requireOpenCodeV2NativeSessionId,
} from "./local-agent-opencode-version.js";

const OPENCODE_PROMPT_TIMEOUT_MS = 5 * 60_000;

export type OpencodeV2ClientLike = Pick<OpenCodeClient, "server" | "session" | "message" | "model">;

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
          await this.client.server.info();
          const continuing = input.providerSessionId !== undefined;

          const nativeSessionId = input.providerSessionId
            ? requireOpenCodeV2NativeSessionId(input.providerSessionId)
            : await this.createSession(input);

          const providerSessionId = encodeOpenCodeV2SessionId(nativeSessionId);
          await callbacks?.onSessionId?.(providerSessionId);

          if (continuing) await this.configureSession(nativeSessionId, input);
          const { promptedAt, messages } = await this.prompt(nativeSessionId, input);
          // On a continued session the latest assistant message may predate this
          // prompt when the new turn failed before producing output.
          const fresh = messages.data.filter((message) => message.time.created >= promptedAt);

          if (fresh.length === 0) await this.assertTurnNotFailed(nativeSessionId);
          const assistant = requireLatestAssistant(fresh);
          assertOpenCodeV2AssistantSucceeded(assistant);
          const finalResponse = requireOpenCodeV2FinalResponse(assistant);
          // OpenCode does not stream activity to DevSpace; report the reply once the turn ends.
          callbacks?.onEvent?.({ type: "message", text: finalResponse });

          return {
            provider: this.provider,
            providerSessionId,
            finalResponse,
            items: fresh,
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

  /**
   * A turn that fails before any assistant output (for example provider auth)
   // SAFETY: Boundary value already validated or constructed to match this type.
   * is recorded as a failed `idle` message, which the assistant-only listing hides.
   */
  private async assertTurnNotFailed(sessionId: string): Promise<void> {
    const recent = await this.client.message.list({ sessionID: sessionId, limit: 5, order: "desc" });

    const idle = recent.data.find((message) => (
      message !== null
      && isJsonObject(message)
      && "type" in message
      && message.type === "idle"
    )) as { outcome?: string; error?: { type?: string; message?: string } } | undefined;

    if (idle?.outcome !== "failed") return;
    throw new AgentProviderExecutionError({
      code: "PROVIDER_EXECUTION_ERROR",
      provider: "opencode",
      operation: "prompt",
      retryable: false,
      cause: idle.error,
      message: idle.error?.message || "OpenCode turn failed before producing a response.",
    });
  }

  private async createSession(input: LocalAgentRunInput): Promise<string> {
    const model = await resolveOpenCodeV2Model(this.client, input);

    const session = await this.client.session.create({
      location: { directory: input.workspaceRoot },
      permissions: opencodeV2Permissions(input.writeMode),
      ...optionalFields(model ? { model } : undefined),
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

    // End the local request only once OpenCode confirms the interrupt (`interrupted: false`
    // means the session was already idle). A failed or stalled interrupt keeps the turn
    // SAFETY: Boundary value already validated or constructed to match this type.
    // running, and the manager reports the stop as a conflict.
    const removeAbort = bindLocalAgentAbort(input.signal, async () => {
      await this.client.session.interrupt({ sessionID: sessionId });
      controller.abort();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.promptTimeoutMs);

    try {
      const prompted = await this.client.session.prompt({
        sessionID: sessionId,
        text: input.prompt,
      }, { signal: controller.signal });

      await this.client.session.wait({ sessionID: sessionId }, { signal: controller.signal });

      const messages = await this.client.message.list({
        sessionID: sessionId,
        limit: 1,
        order: "desc",
        type: "assistant",
      }, { signal: controller.signal });

      return { promptedAt: prompted.time.created, messages };
    } catch (error) {
      // A provider timeout after a stop request is still a timeout: the interrupt was never confirmed.
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
    ...optionalFields(effort ? { variant: effort } : undefined),
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

function requireLatestAssistant(messages: JsonValue[]): SessionMessageAssistant {
  const assistant = messages.find((message) => (
    message !== null
    && isJsonObject(message)
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

  // SAFETY: Boundary value already validated or constructed to match this type.
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

/** @opencode/client wraps every connection failure, whatever its errno, in a Transport ClientError. */
function isOpenCodeTransportFailure(error: JsonValue): boolean {
  return error instanceof ClientError && error.reason === "Transport";
}
