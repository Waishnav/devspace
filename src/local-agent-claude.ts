import { createHash } from "node:crypto";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
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
type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

const CLAUDE_WORKSPACE_ALLOWED_TOOLS = [
  // allowedTools is passed as a session/CLI rule, so `/` is anchored to the query cwd.
  "Read(/**)",
  "Edit(/**)",
  "Bash",
] as const;


export interface ClaudeQueryLike extends AsyncIterable<unknown> {
  close(): void;
  interrupt?(): Promise<void>;
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  setModel?(model?: string): Promise<void>;
}

export interface ClaudeQueryFactoryInput {
  context: LocalAgentRuntimeContext;
  options: Record<string, unknown>;
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

  async run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
    control?: LocalAgentRunControl,
  ) {
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
        const effectiveWriteMode = input.toolPolicy === "read_only" ? "read_only" : input.writeMode;
        const flagSettings = claudeAuthoritySettings(input.workspaceRoot, effectiveWriteMode);
        if (input.effort) {
          Object.assign(flagSettings, {
            alwaysThinkingEnabled: true,
            effortLevel: input.effort,
          });
        }
        await this.query.applyFlagSettings(flagSettings);
        await this.query.setPermissionMode(claudePermissionMode(effectiveWriteMode));
        if (input.model && this.query.setModel) await this.query.setModel(input.model);
        let cancellation: Promise<boolean> | undefined;
        const abort = () => {
          cancellation ??= this.query.interrupt
            ? this.query.interrupt().then(() => true, () => false)
            : Promise.resolve(false);
        };
        if (control?.signal.aborted) throw new DOMException("Aborted", "AbortError");
        control?.signal.addEventListener("abort", abort, { once: true });
        if (control?.signal.aborted) {
          control.signal.removeEventListener("abort", abort);
          throw new DOMException("Aborted", "AbortError");
        }
        this.inputQueue.push({
          type: "user",
          message: { role: "user", content: input.prompt },
          parent_tool_use_id: null,
        });
        const items: unknown[] = [];
        try {
          for (;;) {
          let next: IteratorResult<unknown>;
          try {
            next = await this.iterator.next();
          } catch (error) {
            if (control?.signal.aborted && await cancellation) {
              throw new DOMException("Aborted", "AbortError");
            }
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
          if (control?.signal.aborted && await cancellation) {
            throw new DOMException("Aborted", "AbortError");
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
          const progress = claudeProgress(record);
          if (progress) await callbacks?.onProgress?.(progress);
          if (typeof record?.session_id === "string") {
            const previousSessionId = this.providerSessionId;
            this.providerSessionId = record.session_id;
            if (previousSessionId !== this.providerSessionId) {
              await callbacks?.onSessionId?.(this.providerSessionId);
            }
          }
          if (record?.type !== "result") continue;

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
          const finalResponse = typeof record.result === "string" ? record.result.trim() : "";
          const structuredOutput = jsonValue(record.structured_output);
          if (!finalResponse && structuredOutput === undefined) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: "claude",
              operation: "run",
              retryable: false,
              message: "Claude did not return a final assistant response.",
            });
          }
          const usage = claudeUsage(input, record);
          if (usage) await callbacks?.onUsage?.(usage);
          return {
            provider: this.provider,
            providerSessionId: this.providerSessionId ?? null,
            finalResponse,
            items,
            ...(structuredOutput === undefined ? {} : { structuredOutput }),
            ...(usage ? { usage } : {}),
          };
          }
        } finally {
          control?.signal.removeEventListener("abort", abort);
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
    const schema = context.outputSchema
      ? createHash("sha256").update(JSON.stringify(context.outputSchema)).digest("hex").slice(0, 12)
      : undefined;
    const specialization = context.toolPolicy || schema
      ? `:${context.toolPolicy ?? "normal"}:${schema ?? "text"}`
      : "";
    const workflow = context.workflowRunId ? `:workflow:${context.workflowRunId}` : "";
    return `claude:${context.agentId}:${authority}${specialization}${workflow}`;
  }

  capabilities() {
    return {
      cancellation: "turn",
      structuredOutput: "native",
      usage: "final",
      correctionAuthority: "no_tools",
      permissionRequests: "preconfigured",
      progress: "tools_and_text",
    } as const;
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
          outputSchema: context.outputSchema,
          toolPolicy: context.toolPolicy,
        };
        const query = await this.factory({
          context,
          options: claudeQueryOptions(context, input, this.env),
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
  return query({
    prompt,
    options: options as never,
  }) as unknown as ClaudeQueryLike;
}

export function claudeQueryOptions(
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const executable = env.CLAUDE_COMMAND;
  const permissionMode = claudePermissionMode(input.writeMode);
  const authority = claudeAuthorityOptions(input.workspaceRoot, input.writeMode);
  return {
    cwd: input.workspaceRoot,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { thinking: { type: "adaptive" }, effort: input.effort } : {}),
    ...(input.outputSchema ? { outputFormat: { type: "json_schema", schema: input.outputSchema } } : {}),
    ...(context.providerSessionId ? { resume: context.providerSessionId } : {}),
    permissionMode,
    // Restricted runtimes stay warm across read_only/allowed turns. Keep the
    // workspace capabilities static and narrow individual turns with deny rules.
    ...(input.toolPolicy === "none"
      ? { allowedTools: [] }
      : input.writeMode === "full_access"
      ? {}
      : { allowedTools: [...CLAUDE_WORKSPACE_ALLOWED_TOOLS] }),
    ...(input.workflowRunId ? { disallowedTools: ["Agent", "Task"] } : {}),
    sandbox: authority.sandbox,
    settings: authority.settings,
    ...(input.writeMode === "full_access" ? { allowDangerouslySkipPermissions: true } : {}),
    env: localAgentWorkflowEnvironment(claudeCommandEnvironment(env), input),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
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
): Record<string, unknown> {
  return claudeAuthorityOptions(workspaceRoot, writeMode).settings;
}

function claudeAuthorityOptions(
  workspaceRoot: string,
  writeMode: LocalAgentWriteMode | undefined,
): { sandbox: Record<string, unknown>; settings: Record<string, unknown> } {
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

export function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
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

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function claudeUsage(
  input: LocalAgentRunInput,
  result: Record<string, unknown>,
): LocalAgentUsageUpdate | undefined {
  const usage = asRecord(result.usage);
  if (!usage) return undefined;
  const outputTokens = finiteNonnegative(usage.output_tokens);
  if (outputTokens === undefined) return undefined;
  return {
    attemptId: input.attemptId ?? "untracked",
    sequence: 1,
    inputTokens: finiteNonnegative(usage.input_tokens),
    outputTokens,
    cacheReadTokens: finiteNonnegative(usage.cache_read_input_tokens),
    cacheWriteTokens: finiteNonnegative(usage.cache_creation_input_tokens),
    final: true,
  };
}

function claudeProgress(message: Record<string, unknown> | undefined): LocalAgentProgressUpdate | undefined {
  if (message?.type !== "stream_event") return undefined;
  const event = asRecord(message.event);
  if (event?.type === "content_block_start") {
    const block = asRecord(event.content_block);
    if (block?.type === "tool_use" && typeof block.name === "string") {
      return { type: "tool", toolName: block.name, status: "started" };
    }
  }
  if (event?.type === "content_block_delta") {
    const delta = asRecord(event.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      return { type: "text", text: delta.text.slice(0, 8 * 1024) };
    }
  }
  return undefined;
}

function jsonValue(value: unknown): LocalAgentRunResult["structuredOutput"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result = value.map(jsonValue);
    return result.some((entry, index) => entry === undefined && value[index] !== undefined)
      ? undefined
      : result as LocalAgentRunResult["structuredOutput"];
  }
  const record = asRecord(value);
  if (!record || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const result: Record<string, Exclude<LocalAgentRunResult["structuredOutput"], undefined>> = {};
  for (const [key, entry] of Object.entries(record)) {
    const parsed = jsonValue(entry);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
  }
  return result;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
