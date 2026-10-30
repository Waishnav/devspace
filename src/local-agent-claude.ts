import { unsafeNarrow } from "./unsafe-narrow.js";
import { isJsonString, isObjectValue, optionalFields } from "./json-value.js";
import type { JsonObject, WireInput } from "./json-value.js";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import { summarizeToolInput, type LocalAgentActivityEvent } from "./local-agent-events.js";
import type { LocalAgentDriverKind } from "./local-agent-provider.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

const CLAUDE_WORKSPACE_ALLOWED_TOOLS = [
  // allowedTools is passed as a session/CLI rule, so `/` is anchored to the query cwd.
  "Read(/**)",
  "Edit(/**)",
  "Bash",
] as const;


export interface ClaudeQueryLike extends AsyncIterable<unknown> {
  close(): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  applyFlagSettings(settings: JsonObject): Promise<void>;
  setModel?(model?: string): Promise<void>;
}

export interface ClaudeQueryFactoryInput {
  context: LocalAgentRuntimeContext;
  options: JsonObject;
  prompt: AsyncIterable<ClaudeUserMessage>;
}

export type ClaudeQueryFactory = (
  input: ClaudeQueryFactoryInput,
) => ClaudeQueryLike | Promise<ClaudeQueryLike>;

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("Claude input stream is closed.");
    const waiter = this.waiters.shift();

    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.waiters.length > 0) this.waiters.shift()!.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();

    if (value !== undefined) return Promise.resolve({ done: false, value });

    if (this.closed) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

export class ClaudeQueryRuntime implements LocalAgentRuntime {
  readonly provider: LocalAgentDriverKind = "claude";
  private readonly iterator: AsyncIterator<unknown>;
  private alive = true;
  private closed = false;
  private providerSessionId?: string;

  constructor(
    private readonly query: ClaudeQueryLike,
    private readonly inputQueue: AsyncInputQueue<ClaudeUserMessage>,
    context: LocalAgentRuntimeContext,
  ) {
    this.providerSessionId = context.providerSessionId;
    this.iterator = query[Symbol.asyncIterator]();
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: "claude",
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: "claude",
            operation: "run",
            retryable: true,
            message: "Claude runtime is not running.",
          });
        }

        const removeAbort = bindLocalAgentAbort(input.signal, () => this.query.interrupt());

        try {
        if (this.providerSessionId) await callbacks?.onSessionId?.(this.providerSessionId);
        const flagSettings = claudeAuthoritySettings(input.workspaceRoot, input.writeMode);

        if (input.effort) {
          Object.assign(flagSettings, {
            alwaysThinkingEnabled: true,
            effortLevel: input.effort,
          });
        }

        await this.query.applyFlagSettings(flagSettings);
        await this.query.setPermissionMode(claudePermissionMode(input.writeMode));

        if (input.model && this.query.setModel) await this.query.setModel(input.model);

        if (input.signal?.aborted) throw localAgentCancelledError("claude", "run");
        this.inputQueue.push({
          type: "user",
          message: { role: "user", content: input.prompt },
          parent_tool_use_id: null,
        });

        const items: unknown[] = [];
        const toolCalls = new Map<string, ClaudeToolCall>();

        for (;;) {
          let next: IteratorResult<unknown>;

          try {
            next = await this.iterator.next();
          } catch (error) {
            if (input.signal?.aborted) throw localAgentCancelledError("claude", "run", error);
            this.alive = false;

            if (isProgrammerDefect(error) && !isClaudeExecutableError(error)) throw error;
            throw new AgentProviderUnavailableError({
              code: "PROVIDER_UNAVAILABLE",
              provider: "claude",
              operation: "run",
              retryable: true,
              cause: error,
              message: "Claude query stream failed.",
            });
          }

          if (next.done) {
            this.alive = false;
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: "claude",
              operation: "run",
              retryable: true,
              message: "Claude query ended before returning a result.",
            });
          }

          const message = next.value;
          items.push(message);
          const record = asRecord(message);

          if (record && callbacks?.onEvent) reportClaudeActivity(record, toolCalls, callbacks.onEvent);

          if (isJsonString(record?.session_id)) {
            const previousSessionId = this.providerSessionId;
            this.providerSessionId = record.session_id;

            if (previousSessionId !== this.providerSessionId) {
              await callbacks?.onSessionId?.(this.providerSessionId);
            }
          }

          if (record?.type !== "result") continue;

          if (input.signal?.aborted) throw localAgentCancelledError("claude", "run");

          const resultError = claudeResultError(record);

          if (resultError) {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: "claude",
              operation: "run",
              retryable: false,
              cause: new Error(resultError),
              message: "Claude agent turn failed.",
            });
          }

          const finalResponse = isJsonString(record.result) ? record.result.trim() : "";

          if (!finalResponse) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: "claude",
              operation: "run",
              retryable: false,
              message: "Claude did not return a final assistant response.",
            });
          }

          return {
            provider: this.provider,
            providerSessionId: this.providerSessionId ?? null,
            finalResponse,
            items,
          };
        }
        } finally {
          removeAbort();
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // Claude's streaming query owns the durable session; it remains warm.
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.inputQueue.close();
    this.query.close();
  }
}

export class ClaudeLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "claude" as const;
  readonly providerInstanceId = "claude";
  readonly runtimePolicy = {
    scope: "agent",
    authority: "full_access_boundary",
    idleTimeoutMs: 3 * 60_000,
  } as const;
  readonly capabilities = {
    sessions: { resume: true, close: false },
    turns: { interrupt: true, streaming: true },
    configuration: { modelOverride: true, effortOverride: true },
    permissions: { enforcement: "native" },
    mcp: { supported: true },
  } as const;

  constructor(
    private readonly factory: ClaudeQueryFactory = defaultClaudeQueryFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** The provider's explicit `env` from config, which wins over the inherited session variables DevSpace strips. */
    private readonly envOverrides: Record<string, string> = {},
  ) {}

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const inputQueue = new AsyncInputQueue<ClaudeUserMessage>();

        const input: LocalAgentRunInput = {
          prompt: "",
          workspaceRoot: context.workspaceRoot,
          providerSessionId: context.providerSessionId,
          writeMode: context.writeMode,
          model: context.model,
          effort: context.effort,
        };

        const query = await this.factory({
          context,
          options: claudeQueryOptions(context, input, this.env, this.envOverrides),
          prompt: inputQueue,
        });

        return new ClaudeQueryRuntime(query, inputQueue, context);
      },
    });
  }
}

async function defaultClaudeQueryFactory({
  options,
  prompt,
}: ClaudeQueryFactoryInput): Promise<ClaudeQueryLike> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  return unsafeNarrow<ClaudeQueryLike>(query({
    prompt,
    // SAFETY: The surrounding checks or construction already match this type.
    options: options as never,
  }));
}

export function claudeQueryOptions(
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
  env: NodeJS.ProcessEnv = process.env,
  envOverrides: Record<string, string> = {},
): JsonObject {
  const executable = env.CLAUDE_COMMAND;
  const permissionMode = claudePermissionMode(input.writeMode);
  const authority = claudeAuthorityOptions(input.workspaceRoot, input.writeMode);

  return {
    cwd: input.workspaceRoot,
    ...optionalFields(input.model ? { model: input.model } : undefined),
    ...optionalFields(input.effort ? { thinking: { type: "adaptive" }, effort: input.effort } : undefined),
    ...optionalFields(context.providerSessionId ? { resume: context.providerSessionId } : undefined),
    permissionMode,
    // Restricted runtimes stay warm across read_only/allowed turns. Keep the
    // workspace capabilities static and narrow individual turns with deny rules.
    ...optionalFields(input.writeMode === "full_access" ? undefined : { allowedTools: [...CLAUDE_WORKSPACE_ALLOWED_TOOLS] }),
    sandbox: authority.sandbox,
    settings: authority.settings,
    ...optionalFields(input.writeMode === "full_access" ? { allowDangerouslySkipPermissions: true } : undefined),
    env: claudeCommandEnvironment(env, envOverrides),
    ...optionalFields(executable ? { pathToClaudeCodeExecutable: executable } : undefined),
  };
}

export function claudePermissionMode(
  writeMode: LocalAgentWriteMode | undefined,
): ClaudePermissionMode {
  switch (writeMode) {
    case "read_only":
    case "allowed":
    case undefined:
      return "dontAsk";
    case "full_access": return "bypassPermissions";
  }
}

export function claudeAuthoritySettings(
  workspaceRoot: string,
  writeMode: LocalAgentWriteMode | undefined,
): JsonObject {
  return claudeAuthorityOptions(workspaceRoot, writeMode).settings;
}

function claudeAuthorityOptions(
  workspaceRoot: string,
  writeMode: LocalAgentWriteMode | undefined,
) {
  if (writeMode === "full_access") {
    const sandbox = {
      enabled: false,
      allowUnsandboxedCommands: true,
    };

    return {
      sandbox,
      settings: {
        permissions: { defaultMode: "bypassPermissions" },
        sandbox,
      },
    };
  }

  const allowed = writeMode !== "read_only";

  const permissions = {
    defaultMode: "dontAsk",
    deny: allowed ? [] : ["Bash", "Edit"],
  };

  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: allowed ? [workspaceRoot] : [],
      denyWrite: allowed ? [] : [workspaceRoot],
    },
  };

  return { sandbox, settings: { permissions, sandbox } };
}

/**
 * Drops the session variables a parent Claude Code exports, so a DevSpace started from Claude Code does not make
 * its subagent look like a nested session. Values set explicitly in the provider's config `env` are kept.
 */
export function claudeCommandEnvironment(
  env: NodeJS.ProcessEnv,
  envOverrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const next = { ...env };

  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    if (Object.hasOwn(envOverrides, key)) next[key] = envOverrides[key];
    else delete next[key];
  }

  return next;
}

export function claudeResultError(record: JsonObject): string | undefined {
  const subtype = isJsonString(record.subtype) ? record.subtype : undefined;
  const isError = record.is_error === true || subtype?.startsWith("error");

  if (!isError) return undefined;

  const message =
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";

  return `Claude returned an error result: ${message}`;
}

interface ClaudeToolCall {
  tool: string;
  summary?: string;
}

/** Maps complete SDK messages (no partial deltas) onto DevSpace activity events. */
export function reportClaudeActivity(
  record: JsonObject,
  toolCalls: Map<string, ClaudeToolCall>,
  onEvent: (event: LocalAgentActivityEvent) => void,
): void {
  if (record.type !== "assistant" && record.type !== "user") return;
  const content = asRecord(record.message)?.content;

  if (!Array.isArray(content)) return;

  for (const value of content) {
    const block = asRecord(value);

    if (record.type === "assistant" && block?.type === "text" && isJsonString(block.text)) {
      onEvent({ type: "message", text: block.text });
    } else if (record.type === "assistant" && block?.type === "tool_use" && isJsonString(block.name)) {
      const call = { tool: block.name, summary: summarizeToolInput(block.input) };

      if (isJsonString(block.id)) toolCalls.set(block.id, call);
      onEvent({ type: "tool_started", ...call });
    } else if (record.type === "user" && block?.type === "tool_result" && isJsonString(block.tool_use_id)) {
      const call = toolCalls.get(block.tool_use_id);

      if (!call) continue;
      toolCalls.delete(block.tool_use_id);
      onEvent({ type: "tool_completed", ...call, status: block.is_error === true ? "failed" : "completed" });
    }
  }
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

/** The SDK reports a missing or unlaunchable Claude CLI as a ReferenceError, not as a spawn error. */
function isClaudeExecutableError(error: WireInput): boolean {
  return error instanceof ReferenceError && /^Claude Code (native binary|executable) /.test(error.message);
}

function directString(value: WireInput): string | undefined {
  return isJsonString(value) && value.trim() ? value.trim() : undefined;
}

function asRecord(value: WireInput): JsonObject | undefined {
  return value !== null && isObjectValue(value) && !Array.isArray(value)
    // SAFETY: The surrounding checks or construction already match this type.
    ? unsafeNarrow<JsonObject>(value)
    : undefined;
}
