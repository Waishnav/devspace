import {
  AgentProviderCancelledError,
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { Options, Query, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { z } from "zod";

type ClaudePermissionMode = NonNullable<Options["permissionMode"]>;

const claudeEffortLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);

type ClaudeEffortLevel = z.infer<typeof claudeEffortLevelSchema>;

const CLAUDE_WORKSPACE_ALLOWED_TOOLS = [
  // allowedTools is passed as a session/CLI rule, so `/` is anchored to the query cwd.
  "Read(/**)",
  "Edit(/**)",
  "Bash",
] as const;

export interface ClaudeResultMessage {
  type: "result";
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  error?: string;
  message?: string;
}

interface ClaudeNonResultMessage {
  type: Exclude<SDKMessage["type"], "result">;
  session_id?: string;
}

export type ClaudeQueryMessage = ClaudeResultMessage | ClaudeNonResultMessage;

export interface ClaudeQueryLike
  extends Pick<Query, "close" | "setPermissionMode" | "applyFlagSettings">,
    Partial<Pick<Query, "setModel">>,
    AsyncIterable<ClaudeQueryMessage> {}

export interface ClaudeQueryFactoryInput {
  context: LocalAgentRuntimeContext;
  options: Options;
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
  readonly provider: LocalAgentProvider = "claude";
  private readonly iterator: AsyncIterator<ClaudeQueryMessage>;
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

        if (this.providerSessionId) await callbacks?.onSessionId?.(this.providerSessionId);
        const flagSettings = claudeAuthoritySettings(input.workspaceRoot, input.writeMode);

        if (input.effort) {
          const effort = parseClaudeEffortLevel(input.effort);

          Object.assign(flagSettings, {
            alwaysThinkingEnabled: true,
            effortLevel: effort,
          });
        }

        await this.query.applyFlagSettings(flagSettings);
        await this.query.setPermissionMode(claudePermissionMode(input.writeMode));

        if (input.model) await this.query.setModel?.(input.model);
        this.inputQueue.push({
          type: "user",
          message: { role: "user", content: input.prompt },
          parent_tool_use_id: null,
        });

        const items: ClaudeQueryMessage[] = [];

        for (;;) {
          let next: IteratorResult<ClaudeQueryMessage>;

          try {
            next = await this.iterator.next();
          } catch (error) {
            this.alive = false;

            if (isProgrammerDefect(error)) throw error;
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

          if (message.session_id !== undefined) {
            const previousSessionId = this.providerSessionId;
            this.providerSessionId = message.session_id;

            if (previousSessionId !== this.providerSessionId) {
              await callbacks?.onSessionId?.(this.providerSessionId);
            }
          }

          if (!isClaudeResultMessage(message)) continue;

          const resultError = claudeResultError(message);

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

          const finalResponse = directString(message.result) ?? "";

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
  readonly idleTimeoutMs = 3 * 60_000;

  constructor(
    private readonly factory: ClaudeQueryFactory = defaultClaudeQueryFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const authority = context.writeMode === "full_access" ? "full_access" : "restricted";

    return `claude:${context.agentId}:${authority}`;
  }

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

        let query: ClaudeQueryLike;

        try {
          query = await this.factory({
            context,
            options: claudeQueryOptions(context, input, this.env),
            prompt: inputQueue,
          });
        } catch (error) {
          throwClaudeCancellation("create_runtime", error);
        }

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

  return query({ prompt, options });
}

export function claudeQueryOptions(
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
  env: NodeJS.ProcessEnv = process.env,
): Options {
  const executable = env.CLAUDE_COMMAND;
  const permissionMode = claudePermissionMode(input.writeMode);
  const authority = claudeAuthorityOptions(input.workspaceRoot, input.writeMode);

  const options: Options = {
    cwd: input.workspaceRoot,
    permissionMode,
    sandbox: authority.sandbox,
    settings: authority.settings,
    env: claudeCommandEnvironment(env),
  };

  if (input.model) options.model = input.model;

  if (input.effort) {
    const effort = parseClaudeEffortLevel(input.effort);

    options.thinking = { type: "adaptive" };

    options.effort = effort;
  }

  if (context.providerSessionId) options.resume = context.providerSessionId;

  if (input.writeMode !== "full_access") options.allowedTools = [...CLAUDE_WORKSPACE_ALLOWED_TOOLS];

  if (input.writeMode === "full_access") options.allowDangerouslySkipPermissions = true;

  if (executable) options.pathToClaudeCodeExecutable = executable;

  return options;
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
): Settings {
  return claudeAuthorityOptions(workspaceRoot, writeMode).settings;
}

interface ClaudeAuthorityOptions {
  sandbox: NonNullable<Options["sandbox"]>;
  settings: Settings;
}

function claudeAuthorityOptions(
  workspaceRoot: string,
  writeMode: LocalAgentWriteMode | undefined,
): ClaudeAuthorityOptions {
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
    } satisfies ClaudeAuthorityOptions;
  }

  const allowed = writeMode !== "read_only";

  const permissions: NonNullable<Settings["permissions"]> = {
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

  return { sandbox, settings: { permissions, sandbox } } satisfies ClaudeAuthorityOptions;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };

  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    delete next[key];
  }

  return next;
}

export function claudeResultError(record: ClaudeResultMessage): string | undefined {
  const subtype = record.subtype;
  const isError = record.is_error === true || subtype?.startsWith("error");

  if (!isError) return undefined;

  const message =
    firstNonEmpty(record.errors) ??
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";

  return `Claude returned an error result: ${message}`;
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

function parseClaudeEffortLevel(value: string): ClaudeEffortLevel {
  return claudeEffortLevelSchema.parse(value);
}

function firstNonEmpty(values: string[] | undefined): string | undefined {
  for (const value of values ?? []) {
    const result = directString(value);

    if (result) return result;
  }

  return undefined;
}

function directString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed || undefined;
}

function isClaudeResultMessage(message: ClaudeQueryMessage): message is ClaudeResultMessage {
  return message.type === "result";
}

function throwClaudeCancellation(operation: string, cause: unknown): never {
  if (!isClaudeAbortError(cause)) throw cause;

  throw new AgentProviderCancelledError({
    code: "PROVIDER_CANCELLED",
    provider: "claude",
    operation,
    retryable: false,
    cause,
    message: "Claude agent operation was cancelled.",
  });
}

function isClaudeAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
