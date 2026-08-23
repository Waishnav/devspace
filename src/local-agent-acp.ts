import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import { terminateProcessTree } from "./process-platform.js";
import {
  GrokPromptCompletionRegistry,
  GROK_DEFAULT_MODEL,
  parseGrokPromptCompletion,
  readGrokSessionState,
  resolveGrokEffort,
  resolveGrokModelId,
} from "./local-agent-grok.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export type AcpProvider = "cursor" | "copilot" | "grok";

const MAX_ACP_QUEUE_ITEMS = 10_000;
const MAX_ACP_STDERR_BYTES = 32 * 1024;
const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;
const DEVSPACE_VERSION = readDevspaceVersion();

const observeChildError = (): void => {};

const ACP_COMMANDS: Record<AcpProvider, [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
  grok: ["grok", "agent", "stdio"],
};

interface AcpConnectionLike {
  agent: {
    request(method: string, params?: unknown): Promise<unknown>;
  };
  close(error?: unknown): void;
  closed: Promise<void>;
}

interface AcpCapabilities {
  resume: boolean;
  close: boolean;
  additionalDirectories?: boolean;
}

interface AcpSessionQueue {
  values: unknown[];
}

export interface AcpRuntimeOptions {
  provider: AcpProvider;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child?: ChildProcessWithoutNullStreams;
  capabilities?: AcpCapabilities;
  queues?: Map<string, AcpSessionQueue>;
  liveSessions?: Set<string>;
  sessionWriteModes?: Map<string, LocalAgentWriteMode>;
  sessionMetadata?: Map<string, unknown>;
  grokCompletionRegistry?: GrokPromptCompletionRegistry;
  promptCompletionTimeoutMs?: number;
}

export class AcpRuntime implements LocalAgentRuntime {
  readonly provider: AcpProvider;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly connection: AcpConnectionLike;
  private readonly capabilities: AcpCapabilities;
  private readonly queues: Map<string, AcpSessionQueue>;
  private readonly liveSessions: Set<string>;
  private readonly sessionWriteModes: Map<string, LocalAgentWriteMode>;
  private readonly sessionMetadata: Map<string, unknown>;
  private readonly grokCompletionRegistry?: GrokPromptCompletionRegistry;
  private readonly promptCompletionTimeoutMs: number;
  private readonly activeSessions = new Set<string>();
  private promptSequence = 0;
  private alive = true;
  private closed = false;

  constructor(options: AcpRuntimeOptions, connection: AcpConnectionLike) {
    this.provider = options.provider;
    this.child = options.child;
    this.connection = connection;
    this.capabilities = options.capabilities ?? { resume: false, close: false };
    this.queues = options.queues ?? new Map();
    this.liveSessions = options.liveSessions ?? new Set();
    this.sessionWriteModes = options.sessionWriteModes ?? new Map();
    this.sessionMetadata = options.sessionMetadata ?? new Map();
    this.grokCompletionRegistry = options.grokCompletionRegistry;
    this.promptCompletionTimeoutMs = options.promptCompletionTimeoutMs ?? ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS;
    void this.connection.closed.then(() => {
      if (!this.closed) this.alive = false;
      this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
    }).catch(() => {
      if (!this.closed) this.alive = false;
      this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
    });
    this.child?.once("exit", () => {
      this.alive = false;
      this.connection.close(new Error(`${this.provider} ACP process exited.`));
    });
    this.child?.once("error", (error) => {
      this.alive = false;
      this.connection.close(error);
    });
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: `${this.provider} ACP runtime is not running.`,
          });
        }
        const sessionId = await this.openSession(input, callbacks);
        if (this.activeSessions.has(sessionId)) {
          throw new TypeError(`${this.provider} ACP session ${sessionId} already has an active turn.`);
        }
        this.activeSessions.add(sessionId);
        const queue = this.queues.get(sessionId) ?? { values: [] };
        this.queues.set(sessionId, queue);
        const promptId = this.provider === "grok" ? this.nextPromptId() : undefined;
        const completion = promptId && this.grokCompletionRegistry
          ? this.grokCompletionRegistry.wait(
              sessionId,
              promptId,
              this.promptCompletionTimeoutMs,
              () => new AgentProviderProtocolError({
                code: "PROVIDER_PROTOCOL_ERROR",
                provider: this.provider,
                operation: "run",
                retryable: true,
                message: "Grok ACP did not report completion for the prompt before the timeout.",
              }),
            )
          : undefined;
        try {
          queue.values.length = 0;
          const standardResponse = this.connection.agent.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
            ...(promptId ? { _meta: { promptId, requestId: promptId } } : {}),
          });
          const response = completion
            ? await Promise.race([standardResponse, completion])
            : await standardResponse;
          if (completion && isGrokPromptCompletion(response)) {
            await yieldToAcpQueue();
          } else if (promptId) {
            this.grokCompletionRegistry?.markCompleted(sessionId, promptId);
          }
          const updates = queue.values.splice(0);
          const finalResponse = extractAcpText(updates);
          if (!finalResponse) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: response,
              message: `${this.provider} ACP did not return a final assistant response.`,
            });
          }
          return {
            provider: this.provider,
            providerSessionId: sessionId,
            finalResponse,
            items: updates,
          };
        } finally {
          if (promptId) this.grokCompletionRegistry?.remove(sessionId, promptId);
          this.activeSessions.delete(sessionId);
        }
      },
    });
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    this.queues.delete(providerSessionId);
    this.liveSessions.delete(providerSessionId);
    this.sessionWriteModes.delete(providerSessionId);
    this.sessionMetadata.delete(providerSessionId);
    if (!this.capabilities.close || !this.isAlive()) return;
    await this.connection.agent.request("session/close", { sessionId: providerSessionId });
  }

  isAlive(): boolean {
    return this.alive && !this.closed && (!this.child || (this.child.exitCode === null && !this.child.killed));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.queues.clear();
    this.liveSessions.clear();
    this.sessionWriteModes.clear();
    this.sessionMetadata.clear();
    this.activeSessions.clear();
    this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP runtime closed.`));
    this.connection.close(new Error(`${this.provider} ACP runtime closed.`));
    if (this.child && this.child.exitCode === null) {
      const detached = process.platform !== "win32";
      terminateProcessTree(this.child, "SIGTERM", detached);
      if (!await waitForProcessExit(this.child, 1_000)) {
        terminateProcessTree(this.child, "SIGKILL", detached);
      }
    }
  }

  private async openSession(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<string> {
    if (input.providerSessionId) {
      if (this.liveSessions.has(input.providerSessionId)) {
        this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
        await callbacks?.onSessionId?.(input.providerSessionId);
        await this.configureSession(
          input.providerSessionId,
          input,
          this.sessionMetadata.get(input.providerSessionId),
          false,
        );
        return input.providerSessionId;
      }
      if (!this.capabilities.resume) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "resume_session",
          retryable: false,
          message: `${this.provider} ACP does not advertise session resume support.`,
        });
      }
      const response = await this.connection.agent.request("session/resume", {
        sessionId: input.providerSessionId,
        cwd: input.workspaceRoot,
        mcpServers: [],
        ...this.additionalDirectoryParams(),
      });
      this.cacheSessionMetadata(input.providerSessionId, response);
      this.queues.set(input.providerSessionId, { values: [] });
      this.liveSessions.add(input.providerSessionId);
      this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
      await callbacks?.onSessionId?.(input.providerSessionId);
      await this.configureSession(input.providerSessionId, input, response, false);
      return input.providerSessionId;
    }

    const response = await this.connection.agent.request("session/new", {
      cwd: input.workspaceRoot,
      mcpServers: [],
      ...this.additionalDirectoryParams(),
    });
    const sessionId = readString(response, "sessionId");
    if (!sessionId) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: this.provider,
        operation: "create_session",
        retryable: false,
        cause: response,
        message: `${this.provider} ACP did not return a session id.`,
      });
    }
    this.cacheSessionMetadata(sessionId, response);
    this.queues.set(sessionId, { values: [] });
    this.liveSessions.add(sessionId);
    this.sessionWriteModes.set(sessionId, input.writeMode ?? "allowed");
    await callbacks?.onSessionId?.(sessionId);
    await this.configureSession(sessionId, input, response, true);
    return sessionId;
  }

  private cacheSessionMetadata(sessionId: string, response: unknown): void {
    if (hasAcpConfigOptions(response) || (this.provider === "grok" && readGrokSessionState(response))) {
      this.sessionMetadata.set(sessionId, response);
    }
  }

  private async configureSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response?: unknown,
    isNewSession = false,
  ): Promise<void> {
    const metadata = response ?? this.sessionMetadata.get(sessionId);
    if (this.provider === "grok") {
      await this.configureGrokSession(sessionId, input, metadata, isNewSession);
      return;
    }
    const canConfigure = isNewSession || hasAcpConfigOptions(metadata);
    if (!canConfigure) {
      const requested = [
        input.model && input.modelOverrideRequested ? "model" : undefined,
        input.effort && input.effortOverrideRequested ? "effort" : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
      if (requested) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "configure_session",
          retryable: false,
          message: `${this.provider} ACP cannot apply the requested ${requested} override because the resumed session did not advertise configurable options.`,
        });
      }
      // A durable resumed session keeps its previously selected provider
      // configuration. If resume does not re-advertise config options, do not
      // force a redundant set operation for persisted model/effort values.
      return;
    }
    if (input.model) {
      const config = resolveAcpModelConfigUpdate(metadata, input.model, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
    if (input.effort) {
      const config = resolveAcpEffortConfigUpdate(metadata, input.effort, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
  }

  private async configureGrokSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response: unknown,
    isNewSession: boolean,
  ): Promise<void> {
    const state = readGrokSessionState(response);
    if (!state) {
      const requested = [
        input.model && (isNewSession || input.modelOverrideRequested) ? "model" : undefined,
        input.effort && (isNewSession || input.effortOverrideRequested) ? "effort" : undefined,
      ].filter(Boolean).join(" and ");
      if (requested) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "configure_session",
          retryable: false,
          message: `${this.provider} ACP did not advertise typed model metadata required for the requested ${requested} override.`,
        });
      }
      return;
    }

    const currentModel = state.currentModelId;
    const requestedModel = input.model
      ? resolveGrokModelId(input.model, state)
      : currentModel ?? state.availableModels[0]?.id ?? GROK_DEFAULT_MODEL;
    const effort = input.effort
      ? resolveGrokEffort(input.effort, state, requestedModel)
      : undefined;
    const shouldSetModel = Boolean(input.model && requestedModel !== currentModel) || effort !== undefined;
    if (!shouldSetModel) return;

    try {
      await this.connection.agent.request("session/set_model", {
        sessionId,
        modelId: requestedModel,
        ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
      });
    } catch (cause) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: this.provider,
        operation: "configure_session",
        retryable: false,
        cause,
        message: `${this.provider} ACP could not select model '${requestedModel}'.`,
      });
    }
  }

  private additionalDirectoryParams(): { additionalDirectories?: string[] } {
    // DevSpace currently authorizes exactly one workspace root per agent turn.
    // Do not advertise an empty additional-directory scope to ACP providers.
    return {};
  }

  private nextPromptId(): string {
    this.promptSequence += 1;
    return `devspace-grok-prompt-${this.promptSequence}`;
  }
}

export class AcpLocalAgentDriver implements LocalAgentDriver {
  readonly provider: AcpProvider;
  // Keep ACP warm briefly, then let the generic pool close the process so the
  // daemon can reach its own idle shutdown state.
  readonly idleTimeoutMs = 5 * 60_000;
  private commandResolved = false;
  private resolvedCommand?: string;

  constructor(
    provider: AcpProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: AcpCommandResolver = resolveAcpCommand,
  ) {
    this.provider = provider;
  }

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand() ?? ACP_COMMANDS[this.provider][0];
    const writeMode = context.writeMode ?? "allowed";
    return `acp:${this.provider}:${command}:${writeMode}:${resolve(context.workspaceRoot)}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: `${this.provider} executable was not found.`,
          });
        }
        const args = acpCommandArgs(this.provider, context, this.env);
        const child = spawn(command, args, {
          cwd: resolve(context.workspaceRoot),
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        let resolveStartupError!: (error: Error) => void;
        const startupError = new Promise<Error>((resolveError) => { resolveStartupError = resolveError; });
        const onStartupError = (error: Error) => { resolveStartupError(error); };
        child.once("error", onStartupError);
        if (!child.stdin || !child.stdout || !child.stderr) {
          child.on("error", observeChildError);
          child.removeListener("error", onStartupError);
          if (child.exitCode === null) {
            const detached = process.platform !== "win32";
            terminateProcessTree(child, "SIGTERM", detached);
            if (!await waitForProcessExit(child, 1_000)) {
              terminateProcessTree(child, "SIGKILL", detached);
            }
          }
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: `${this.provider} ACP process did not expose stdio pipes.`,
          });
        }

        let connection: AcpConnectionLike | undefined;
        child.stderr.setEncoding("utf8");
        let stderrTail = "";
        child.stderr.on("data", (chunk: string) => {
          stderrTail = appendTail(stderrTail, chunk, MAX_ACP_STDERR_BYTES);
        });
        try {
          const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
          const queues = new Map<string, AcpSessionQueue>();
          const sessionWriteModes = new Map<string, LocalAgentWriteMode>();
          const grokCompletionRegistry = this.provider === "grok"
            ? new GrokPromptCompletionRegistry()
            : undefined;
          const app = client({ name: "DevSpace" })
            .onRequest(methods.client.session.requestPermission, (context) => {
              const writeMode = sessionWriteModes.get(context.params.sessionId);
              const selected = selectAcpPermissionOption(context.params.options, writeMode, this.provider);
              return selected
                ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                : { outcome: { outcome: "cancelled" } };
            })
            .onNotification(methods.client.session.update, (context) => {
              const sessionId = context.params.sessionId;
              const queue = queues.get(sessionId);
              if (queue) appendAcpQueueValue(queue, context.params);
            });
          if (grokCompletionRegistry) {
            for (const method of [
              "x.ai/session/prompt_complete",
              "_x.ai/session/prompt_complete",
              "x.ai/session/update",
              "_x.ai/session/update",
            ]) {
              app.onNotification(method, parseGrokPromptCompletion, (context) => {
                if (context.params) grokCompletionRegistry.resolve(context.params);
              });
            }
          }
          const stream = ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          );
          connection = app.connect(stream) as unknown as AcpConnectionLike;
          const init = await withTimeout(Promise.race([
            connection.agent.request(methods.agent.initialize, {
              protocolVersion: 1,
              clientInfo: { name: "DevSpace", version: DEVSPACE_VERSION },
              clientCapabilities: {},
            }),
            startupError.then((error) => { throw error; }),
          ]),
          ACP_INITIALIZE_TIMEOUT_MS,
          `${this.provider} ACP initialize timed out.`,
          );
          const capabilities = readAcpCapabilities(init);
          const runtime = new AcpRuntime({
            provider: this.provider,
            command,
            args,
            env: this.env,
            child,
            capabilities,
            queues,
            sessionWriteModes,
            grokCompletionRegistry,
          }, connection);
          // AcpRuntime installs the long-lived child error listener before this
          // startup-only listener is removed, so there is no unobserved gap.
          child.removeListener("error", onStartupError);
          return runtime;
        } catch (error) {
          child.on("error", observeChildError);
          child.removeListener("error", onStartupError);
          try {
            connection?.close(error);
          } catch {
            // The child still needs to be terminated if the protocol failed early.
          }
          if (child.exitCode === null) {
            const detached = process.platform !== "win32";
            terminateProcessTree(child, "SIGTERM", detached);
            if (!await waitForProcessExit(child, 1_000)) {
              terminateProcessTree(child, "SIGKILL", detached);
            }
          }
          if (isProgrammerDefect(error)) throw error;
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: true,
            cause: { error, stderr: stderrTail.trim() || undefined },
            message: `${this.provider} ACP initialization failed.`,
          });
        }
      },
    });
  }

  private resolveCommand(): string | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.provider, this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export function resolveAcpCommand(
  provider: AcpProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = provider === "cursor"
    ? env.CURSOR_COMMAND
    : provider === "copilot"
      ? env.COPILOT_COMMAND
      : env.GROK_COMMAND;
  const command = configured ?? ACP_COMMANDS[provider][0];
  if (command.includes("/") || command.includes("\\")) return executableExists(command) ? command : undefined;
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export type AcpCommandResolver = (provider: AcpProvider, env: NodeJS.ProcessEnv) => string | undefined;

export function acpCommandArgs(
  provider: AcpProvider,
  context: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const writeMode = context.writeMode ?? "allowed";
  if (provider === "cursor") {
    return [
      "acp",
      "--sandbox", writeMode === "full_access" ? "disabled" : "enabled",
      "--workspace", resolve(context.workspaceRoot),
      ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
      ...(writeMode === "full_access" ? ["--force"] : []),
    ];
  }
  if (provider === "grok") {
    const agentProfile = env.GROK_AGENT_PROFILE?.trim();
    const effort = context.effort
      ? resolveGrokEffort(context.effort, undefined, undefined)
      : undefined;
    return [
      "agent",
      ...(agentProfile ? ["--agent-profile", agentProfile] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      "stdio",
    ];
  }
  const sandboxArgs = writeMode === "full_access"
    ? ["--no-sandbox"]
    : ["--experimental", "--sandbox"];
  return [
    "--acp",
    ...sandboxArgs,
    ...(writeMode === "full_access"
      ? ["--allow-all"]
      : ["--allow-all-tools", "--add-dir", resolve(context.workspaceRoot)]),
    "-C", resolve(context.workspaceRoot),
    ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
  ];
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
    sessionIdOverride,
  });
}

export function resolveAcpEffortConfigUpdate(
  session: unknown,
  effort: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "reasoning effort option",
    provider,
    value: effort,
    sessionIdOverride,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
    sessionIdOverride?: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session metadata is missing.`);
  const sessionId = options.sessionIdOverride ?? directString(record?.sessionId);
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);
  const response = asRecord(record?.newSessionResponse) ?? record;
  const configOptions = readArray(response, "configOptions") ?? [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);
  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }
  return { sessionId, configId, value: options.value };
}

export function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

export function selectAcpAllowPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
): { optionId: string } | undefined {
  return selectAcpPermissionOption(options, "allowed");
}

export function selectAcpPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
  writeMode: LocalAgentWriteMode | undefined,
  provider?: AcpProvider,
): { optionId: string } | undefined {
  if (!writeMode) return undefined;
  // Copilot's native sandbox has a per-command escape hatch enabled by
  // default. Normal turns already pass --allow-all-tools, so any permission
  // request that reaches ACP is an attempted escalation (including a
  // sandbox bypass). Cancel it instead of turning an ACP approval into host
  // authority. Full access deliberately keeps the provider's unrestricted
  // behavior.
  if (provider === "copilot" && writeMode !== "full_access") return undefined;
  const selected = writeMode === "read_only"
    ? options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always")
    : options.find((option) => option.kind === "allow_once")
      ?? options.find((option) => option.kind === "allow_always");
  return selected ? { optionId: selected.optionId } : undefined;
}

function readAcpCapabilities(value: unknown): AcpCapabilities {
  const capabilities = asRecord(asRecord(value)?.agentCapabilities);
  const sessions = asRecord(capabilities?.sessionCapabilities);
  return {
    resume: Boolean(sessions?.resume),
    close: Boolean(sessions?.close),
    additionalDirectories: Boolean(sessions?.additionalDirectories),
  };
}

function extractAcpText(updates: unknown[]): string {
  return updates
    .map((value) => {
      const update = asRecord(asRecord(value)?.update);
      const content = asRecord(update?.content);
      return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string"
        ? content.text
        : "";
    })
    .join("")
    .trim();
}

function isGrokPromptCompletion(value: unknown): boolean {
  const record = asRecord(value);
  return typeof record?.sessionId === "string";
}

async function yieldToAcpQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hasAcpConfigOptions(value: unknown): boolean {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;
  return Array.isArray(response?.configOptions);
}

function appendAcpQueueValue(queue: AcpSessionQueue, value: unknown): void {
  if (queue.values.length >= MAX_ACP_QUEUE_ITEMS) queue.values.shift();
  queue.values.push(value);
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}

function executableExists(command: string): boolean {
  try {
    accessSync(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readDevspaceVersion(): string {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("Unable to read DevSpace package version.");
  }
  return packageJson.version;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
