import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
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

export interface ClaudeQueryLike extends AsyncIterable<unknown> {
  close(): void;
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
          Object.assign(flagSettings, {
            alwaysThinkingEnabled: true,
            effortLevel: input.effort,
          });
        }
        await this.query.applyFlagSettings(flagSettings);
        await this.query.setPermissionMode(claudePermissionMode(input.writeMode));
        if (input.model && this.query.setModel) await this.query.setModel(input.model);
        this.inputQueue.push({
          type: "user",
          message: { role: "user", content: input.prompt },
          parent_tool_use_id: null,
        });

        const items: unknown[] = [];
        for (;;) {
          let next: IteratorResult<unknown>;
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
          const record = asRecord(message);
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
  const executable = env.CLAUDE_COMMAND ?? resolveExecutable("claude", env);
  const permissionMode = claudePermissionMode(input.writeMode);
  const authority = claudeAuthorityOptions(input.workspaceRoot, input.writeMode);
  return {
    cwd: input.workspaceRoot,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { thinking: { type: "adaptive" }, effort: input.effort } : {}),
    ...(context.providerSessionId ? { resume: context.providerSessionId } : {}),
    permissionMode,
    sandbox: authority.sandbox,
    settings: authority.settings,
    ...(input.writeMode === "full_access" ? { allowDangerouslySkipPermissions: true } : {}),
    env: claudeCommandEnvironment(env),
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

  const resolvedWorkspace = workspaceRoot.replaceAll("\\", "/");
  const workspaceRules = [
    `Read(${resolvedWorkspace}/**)`,
    `Glob(${resolvedWorkspace}/**)`,
    `Grep(${resolvedWorkspace}/**)`,
    `LS(${resolvedWorkspace}/**)`,
  ];
  const allowed = writeMode !== "read_only";
  const protectedPaths = claudeProtectedPaths();
  const permissions = {
    defaultMode: "dontAsk",
    allow: [
      ...workspaceRules,
      ...(allowed ? [`Edit(${resolvedWorkspace}/**)`, "Bash(*)"] : []),
    ],
    deny: [
      ...protectedPaths.map((path) => `Read(${path.replaceAll("\\", "/")}/**)`),
      ...(allowed ? [] : ["Bash(*)", "Edit(*)", "Write(*)", "NotebookEdit(*)"]),
    ],
  };
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: allowed ? [workspaceRoot] : [],
      denyWrite: allowed ? [] : [workspaceRoot],
      denyRead: protectedPaths,
      allowRead: [workspaceRoot],
    },
  };
  return { sandbox, settings: { permissions, sandbox } };
}

function claudeProtectedPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
  ];
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

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const commandHasPath = command.includes("/") || command.includes("\\");
  if (commandHasPath) return command;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
