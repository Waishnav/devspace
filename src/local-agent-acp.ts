import { unsafeNarrow } from "./unsafe-narrow.js";
import { isJsonString, isObjectValue, optionalFields } from "./json-value.js";
import type { WireInput, JsonObject } from "./json-value.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
} from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import { summarizeToolInput, type LocalAgentActivityEvent } from "./local-agent-events.js";
import { terminateProcessTree } from "./process-platform.js";
import { DEVSPACE_VERSION } from "./version.js";
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
  LocalAgentModel,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { resolveExecutableCommand } from "./local-agent-command.js";

export type AcpFlavor = "cursor" | "copilot" | "grok" | "generic";

export type AcpProvider = AcpFlavor;

const MAX_ACP_QUEUE_ITEMS = 10_000;
const MAX_ACP_STDERR_BYTES = 32 * 1024;
const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS = 10 * 60_000;

// How long a provider gets to answer session/prompt after session/cancel before its process is dropped.
const ACP_CANCEL_GRACE_MS = 10_000;
const require = createRequire(import.meta.url);

// SAFETY: The surrounding checks or construction already match this type.
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

const observeChildError = (): void => {};

// `--mode plan` is ignored by `cursor-agent acp` and `copilot --acp`, so a read-only turn selects a
// restricted session mode instead. Cursor's plan mode blocks on a plan approval that an unattended
// turn never gets, so it uses ask mode.
const ACP_READ_ONLY_MODES: Partial<Record<AcpFlavor, string>> = {
  cursor: "ask",
  copilot: "https://agentclientprotocol.com/protocol/session-modes#plan",
};

const ACP_COMMANDS: Partial<Record<AcpFlavor, [string, ...string[]]>> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
  grok: ["grok", "agent", "stdio"],
};

interface AcpConnectionLike {
  agent: {
    request(method: string, params?: WireInput): Promise<WireInput>;
    notify(method: string, params?: WireInput): Promise<void>;
  };
  close(error?: WireInput): void;
  closed: Promise<void>;
}

interface AcpCapabilities {
  resume: boolean;
  close: boolean;
  additionalDirectories?: boolean;
}

interface AcpSessionQueue {
  values: unknown[];
  /** Set while a turn runs so session/update notifications are reported as they arrive. */
  onUpdate?: (value: WireInput) => void;
}

export interface AcpRuntimeOptions {
  flavor: AcpFlavor;
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
  cancelGraceMs?: number;
}

export class AcpRuntime implements LocalAgentRuntime {
  readonly provider = "acp" as const;
  private readonly flavor: AcpFlavor;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly connection: AcpConnectionLike;
  private readonly capabilities: AcpCapabilities;
  private readonly queues: Map<string, AcpSessionQueue>;
  private readonly liveSessions: Set<string>;
  private readonly sessionWriteModes: Map<string, LocalAgentWriteMode>;
  private readonly sessionMetadata: Map<string, unknown>;
  private readonly grokCompletionRegistry?: GrokPromptCompletionRegistry;
  private readonly promptCompletionTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly activeSessions = new Set<string>();
  private promptSequence = 0;
  private alive = true;
  private closed = false;

  constructor(options: AcpRuntimeOptions, connection: AcpConnectionLike) {
    this.flavor = options.flavor;
    this.child = options.child;
    this.connection = connection;
    this.capabilities = options.capabilities ?? { resume: false, close: false };
    this.queues = options.queues ?? new Map();
    this.liveSessions = options.liveSessions ?? new Set();
    this.sessionWriteModes = options.sessionWriteModes ?? new Map();
    this.sessionMetadata = options.sessionMetadata ?? new Map();
    this.grokCompletionRegistry = options.grokCompletionRegistry;
    this.promptCompletionTimeoutMs = options.promptCompletionTimeoutMs ?? ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? ACP_CANCEL_GRACE_MS;
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

        if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run");

        if (this.activeSessions.has(sessionId)) {
          throw new TypeError(`${this.provider} ACP session ${sessionId} already has an active turn.`);
        }

        this.activeSessions.add(sessionId);

        const removeAbort = bindLocalAgentAbort(input.signal, () => (
          this.connection.agent.notify("session/cancel", { sessionId })
        ));

        // A provider that ignores session/cancel would leave the turn running forever:
        // give up on it after a grace period and drop the process so the next turn starts clean.
        let cancelTimer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;

        const cancelDeadline = input.signal && new Promise<never>((_, reject) => {
          onAbort = () => {
            cancelTimer = setTimeout(() => {
              void this.close();
              reject(localAgentCancelledError(this.provider, "run", new Error(
                `${this.provider} did not acknowledge session/cancel within ${this.cancelGraceMs}ms.`,
              )));
            }, this.cancelGraceMs);
          };

          if (input.signal?.aborted) onAbort();
          else input.signal?.addEventListener("abort", onAbort, { once: true });
        });

        cancelDeadline?.catch(() => undefined);
        const queue = this.queues.get(sessionId) ?? { values: [] };
        this.queues.set(sessionId, queue);
        const promptId = this.flavor === "grok" ? this.nextPromptId() : undefined;

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

        const activity = callbacks?.onEvent ? new AcpActivityReporter(callbacks.onEvent) : undefined;

        if (activity) queue.onUpdate = (value) => activity.handle(value);

        try {
          queue.values.length = 0;

          const standardResponse = this.connection.agent.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
            ...optionalFields(promptId ? { _meta: { promptId, requestId: promptId } } : undefined),
          });

          let response: unknown;

          try {
            response = await Promise.race([
              standardResponse,
              ...(completion ? [completion] : []),
              ...(cancelDeadline ? [cancelDeadline] : []),
            ]);
          } catch (cause) {
            if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run", cause);
            throw cause;
          }

          if (input.signal?.aborted) throw localAgentCancelledError(this.provider, "run");

          if (completion && isGrokPromptCompletion(response)) {
            await yieldToAcpQueue();
          } else if (promptId) {
            this.grokCompletionRegistry?.markCompleted(sessionId, promptId);
          }

          const updates = queue.values.splice(0);
          activity?.flush();
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
          queue.onUpdate = undefined;
          removeAbort();
          clearTimeout(cancelTimer);

          if (onAbort) input.signal?.removeEventListener("abort", onAbort);

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

  /** Opens a throwaway read-only session in `workspaceRoot` to read the models the agent offers there. */
  async listModels(workspaceRoot: string): Promise<LocalAgentModel[]> {
    const response = await this.connection.agent.request("session/new", {
      cwd: workspaceRoot,
      mcpServers: [],
      ...this.additionalDirectoryParams(),
      ...this.permissionMeta({ prompt: "", workspaceRoot, writeMode: "read_only" }),
    });

    return acpModelsFromSession(response, this.flavor);
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
        ...this.permissionMeta(input),
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
      ...this.permissionMeta(input),
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

  private cacheSessionMetadata(sessionId: string, response: WireInput): void {
    if (hasAcpConfigOptions(response) || (this.flavor === "grok" && readGrokSessionState(response))) {
      this.sessionMetadata.set(sessionId, response);
    }
  }

  private async configureSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response?: WireInput,
    isNewSession = false,
  ): Promise<void> {
    const metadata = response ?? this.sessionMetadata.get(sessionId);

    if (this.flavor === "grok") {
      await this.configureGrokSession(sessionId, input, metadata, isNewSession);

      return;
    }

    await this.enforceReadOnlyMode(sessionId, input);
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
      const config = resolveAcpModelConfigUpdate(metadata, input.model, this.flavor, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }

    if (input.effort) {
      const config = resolveAcpEffortConfigUpdate(metadata, input.effort, this.flavor, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
  }

  private async enforceReadOnlyMode(sessionId: string, input: LocalAgentRunInput): Promise<void> {
    const modeId = ACP_READ_ONLY_MODES[this.flavor];

    if (input.writeMode !== "read_only" || !modeId) return;

    try {
      await this.connection.agent.request("session/set_mode", { sessionId, modeId });
    } catch (cause) {
      // Fail closed: without the restricted mode the turn could write.
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: this.provider,
        operation: "configure_session",
        retryable: false,
        cause,
        message: `${this.provider} ACP could not enter its read-only mode '${modeId}'.`,
      });
    }
  }

  private async configureGrokSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response: WireInput,
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
        ...optionalFields(effort ? { _meta: { reasoningEffort: effort } } : undefined),
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

  /**
   * Grok follows the user's own always-approve setting unless the client says otherwise, which would
   * bypass the permission requests that enforce the write mode. Only full_access may skip them.
   */
  private permissionMeta(input: LocalAgentRunInput): { _meta?: { yoloMode: boolean } } {
    return this.flavor === "grok" ? { _meta: { yoloMode: input.writeMode === "full_access" } } : {};
  }

  private additionalDirectoryParams() {
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
  readonly provider = "acp" as const;
  readonly providerInstanceId = "acp";
  // Agent-scoped: a stop that outlives the cancel grace period closes the
  // runtime, which must not take other agents' turns down with it.
  readonly runtimePolicy = {
    scope: "agent",
    authority: "write_mode",
    idleTimeoutMs: 5 * 60_000,
  } as const;
  readonly capabilities = {
    sessions: { resume: true, close: true },
    turns: { interrupt: true, streaming: true },
    configuration: { modelOverride: true, effortOverride: true },
    permissions: { enforcement: "native" },
    mcp: { supported: true },
  } as const;
  private commandResolved = false;
  private resolvedCommand?: string;
  private readonly flavor: AcpFlavor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configuredCommand?: string;
  private readonly configuredArgs?: string[];
  private readonly commandResolver: AcpCommandResolver;

  constructor(options: {
    flavor?: Exclude<AcpFlavor, "generic">;
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    commandResolver?: AcpCommandResolver;
  } = {}) {
    this.flavor = options.flavor ?? "generic";
    this.env = options.env ?? process.env;
    this.configuredCommand = options.command;
    this.configuredArgs = options.args;
    this.commandResolver = options.commandResolver ?? resolveAcpCommand;
  }

  async listModels(workspaceRoot: string) {
    const runtime = await this.createRuntime({
      agentId: "models",
      providerInstanceId: this.providerInstanceId,
      provider: this.provider,
      workspaceRoot,
      writeMode: "read_only",
    });

    if (runtime.isErr()) return runtime;

    return captureAgentProviderResult({
      provider: this.provider,
      operation: "list_models",
      run: async () => {
        try {
          // SAFETY: createRuntime only ever returns an AcpRuntime.
          return await unsafeNarrow<AcpRuntime>(runtime.value).listModels(workspaceRoot);
        } finally {
          await runtime.value.close();
        }
      },
    });
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

        if (this.flavor === "generic" && context.writeMode !== "full_access") {
          // DevSpace cannot bound what an arbitrary ACP agent writes: it may act
          // without asking for permission, so only an explicit full_access turn may run it.
          throw new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: `Generic ACP providers cannot enforce the ${context.writeMode ?? "allowed"} write mode; run them with full_access.`,
          });
        }

        // Built-in flavors derive their sandbox flags from the write mode, so only
        // generic providers take configured arguments.
        const args = this.flavor === "generic"
          ? this.configuredArgs ?? []
          : acpCommandArgs(this.flavor, context, this.env);

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

          const grokCompletionRegistry = this.flavor === "grok"
            ? new GrokPromptCompletionRegistry()
            : undefined;

          const app = client({ name: "DevSpace" })
            .onRequest(methods.client.session.requestPermission, (context) => {
              const writeMode = sessionWriteModes.get(context.params.sessionId);
              const selected = selectAcpPermissionOption(context.params.options, writeMode, this.flavor);

              return selected
                ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                : { outcome: { outcome: "cancelled" } };
            })
            .onNotification(methods.client.session.update, (context) => {
              deliverAcpSessionUpdate(queues, context.params);
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
            // SAFETY: The surrounding checks or construction already match this type.
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            // SAFETY: The surrounding checks or construction already match this type.
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          );

          connection = unsafeNarrow<AcpConnectionLike>(app.connect(stream));

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
            flavor: this.flavor,
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
      this.resolvedCommand = this.commandResolver(this.flavor, this.env, this.configuredCommand);
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
  provider: AcpFlavor,
  env: NodeJS.ProcessEnv = process.env,
  explicitCommand?: string,
): string | undefined {
  const configured = explicitCommand ?? (provider === "cursor"
    ? env.CURSOR_COMMAND
    : provider === "copilot"
      ? env.COPILOT_COMMAND
      : provider === "grok"
        ? env.GROK_COMMAND
        : undefined);

  const command = configured ?? ACP_COMMANDS[provider]?.[0];

  if (!command) return undefined;

  return resolveExecutableCommand(command, env);
}

/** Default executable for a built-in ACP flavor, for diagnostics. */
export function acpFlavorCommand(flavor: AcpFlavor): string | undefined {
  return ACP_COMMANDS[flavor]?.[0];
}

export type AcpCommandResolver = (
  provider: AcpFlavor,
  env: NodeJS.ProcessEnv,
  explicitCommand?: string,
) => string | undefined;

export function acpCommandArgs(
  provider: AcpFlavor,
  context: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const writeMode = context.writeMode ?? "allowed";

  if (provider === "cursor") {
    return [
      "acp",
      "--sandbox", writeMode === "full_access" ? "disabled" : "enabled",
      "--workspace", resolve(context.workspaceRoot),
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

  if (provider === "generic") return [];

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
  ];
}

/** Reads selectable models from a `session/new` response: Grok model state, a `model` select, or ACP `models`. */
export function acpModelsFromSession(response: WireInput, flavor: AcpFlavor): LocalAgentModel[] {
  if (flavor === "grok") {
    const state = readGrokSessionState(response);

    return (state?.availableModels ?? []).map((model) => ({
      id: model.id,
      ...optionalFields(model.reasoningEfforts.length > 0 ? { efforts: [...model.reasoningEfforts] } : undefined),
      ...optionalFields(model.id === state?.currentModelId ? { default: true } : undefined),
    }));
  }

  const record = asRecord(response);
  const session = asRecord(record?.newSessionResponse) ?? record;

  const selects = (readArray(session, "configOptions") ?? []).map(asRecord)
    .filter((option): option is JsonObject => option?.type === "select");

  const modelSelect = selects.find((option) => option.category === "model");

  const effortSelect = selects.find((option) => option.category === "thought_level");
  const efforts = effortSelect ? flattenAcpSelectValues(effortSelect) : [];

  if (modelSelect) {
    const current = directString(modelSelect.currentValue);

    return flattenAcpSelectOptions(modelSelect).map(({ value, name }) => ({
      id: value,
      ...optionalFields(name ? { name } : undefined),
      ...optionalFields(efforts.length > 0 ? { efforts } : undefined),
      ...optionalFields(value === current ? { default: true } : undefined),
    }));
  }

  const models = asRecord(session?.models);
  const current = directString(models?.currentModelId);

  return (readArray(models, "availableModels") ?? []).flatMap((entry) => {
    const model = asRecord(entry);
    const id = directString(model?.modelId);

    if (!id) return [];

    const name = directString(model?.name);

    return [{
      id,
      ...optionalFields(name ? { name } : undefined),
      ...optionalFields(id === current ? { default: true } : undefined),
    }];
  });
}

function flattenAcpSelectOptions(option: JsonObject): Array<{ value: string; name?: string }> {
  return (readArray(option, "options") ?? []).flatMap((item) => {
    const record = asRecord(item);
    const value = directString(record?.value);

    if (value) return [{ value, ...optionalFields(directString(record?.name) ? { name: directString(record?.name)! } : undefined) }];

    return (readArray(record, "options") ?? []).flatMap((nested) => {
      const nestedRecord = asRecord(nested);
      const nestedValue = directString(nestedRecord?.value);

      return nestedValue
        ? [{ value: nestedValue, ...optionalFields(directString(nestedRecord?.name) ? { name: directString(nestedRecord?.name)! } : undefined) }]
        : [];
    });
  });
}

export function resolveAcpModelConfigUpdate(
  session: WireInput,
  model: string,
  provider: string,
  sessionIdOverride?: string,
) {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
    sessionIdOverride,
  });
}

export function resolveAcpEffortConfigUpdate(
  session: WireInput,
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
  session: WireInput,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
    sessionIdOverride?: string;
  },
) {
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
  const value = matchAcpSelectValue(available, options.value);

  if (!value) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value };
}

/**
 * Accepts an exact option value, or a plain name such as `composer-2.5` when exactly one option is that name plus
 * bracketed settings (Cursor's `composer-2.5[fast=true]`). An ambiguous name matches nothing.
 */
export function matchAcpSelectValue(available: readonly string[], requested: string): string | undefined {
  if (available.includes(requested)) return requested;

  const variants = available.filter((value) => value.startsWith(`${requested}[`) && value.endsWith("]"));

  return variants.length === 1 ? variants[0] : undefined;
}

export function flattenAcpSelectValues(option: JsonObject): string[] {
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
  provider?: AcpFlavor,
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

function readAcpCapabilities(value: WireInput): AcpCapabilities {
  const capabilities = asRecord(asRecord(value)?.agentCapabilities);
  const sessions = asRecord(capabilities?.sessionCapabilities);

  return {
    resume: Boolean(sessions?.resume),
    close: Boolean(sessions?.close),
    additionalDirectories: Boolean(sessions?.additionalDirectories),
  };
}

function extractAcpText(updates: WireInput[]): string {
  return updates
    .map((value) => {
      const update = asRecord(asRecord(value)?.update);
      const content = asRecord(update?.content);

      return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && isJsonString(content.text)
        ? content.text
        : "";
    })
    .join("")
    .trim();
}

function isGrokPromptCompletion(value: WireInput): boolean {
  const record = asRecord(value);

  return isJsonString(record?.sessionId);
}

async function yieldToAcpQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hasAcpConfigOptions(value: WireInput): boolean {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;

  return Array.isArray(response?.configOptions);
}

/** Routes one session/update notification to the session's queue, if DevSpace is tracking it. */
export function deliverAcpSessionUpdate(
  queues: Map<string, AcpSessionQueue>,
  params: { sessionId: string },
): void {
  const queue = queues.get(params.sessionId);

  if (queue) appendAcpQueueValue(queue, params);
}

function appendAcpQueueValue(queue: AcpSessionQueue, value: WireInput): void {
  if (queue.values.length >= MAX_ACP_QUEUE_ITEMS) queue.values.shift();
  queue.values.push(value);
  queue.onUpdate?.(value);
}

/**
 * Maps ACP session updates onto activity events. Message chunks are deltas,
 * so they are buffered into one message per stretch of assistant text.
 */
export class AcpActivityReporter {
  private readonly toolCalls = new Map<string, { tool: string; summary?: string }>();
  private text = "";

  constructor(private readonly onEvent: (event: LocalAgentActivityEvent) => void) {}

  handle(value: WireInput): void {
    const update = asRecord(asRecord(value)?.update);

    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const content = asRecord(update.content);

        if (content?.type === "text" && isJsonString(content.text)) this.text += content.text;

        return;
      }

      case "tool_call": {
        this.flush();

        const call = {
          tool: isJsonString(update.kind) && update.kind ? update.kind : "tool",
          summary: isJsonString(update.title) ? update.title : summarizeToolInput(update.rawInput),
        };

        const id = isJsonString(update.toolCallId) ? update.toolCallId : undefined;

        if (id) this.toolCalls.set(id, call);
        this.onEvent({ type: "tool_started", ...call });
        this.complete(id, update.status);

        return;
      }

      case "tool_call_update": {
        const id = isJsonString(update.toolCallId) ? update.toolCallId : undefined;
        const call = id ? this.toolCalls.get(id) : undefined;

        if (call && isJsonString(update.title)) call.summary = update.title;
        this.complete(id, update.status);

        return;
      }
    }
  }

  flush(): void {
    if (this.text.trim()) this.onEvent({ type: "message", text: this.text });
    this.text = "";
  }

  private complete(id: string | undefined, status: WireInput): void {
    if (status !== "completed" && status !== "failed") return;
    const call = id ? this.toolCalls.get(id) : undefined;

    if (!call || !id) return;
    this.toolCalls.delete(id);
    this.onEvent({ type: "tool_completed", ...call, status });
  }
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;

  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;

  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
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

function readArray(value: WireInput, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];

  return Array.isArray(result) ? result : undefined;
}

function readString(value: WireInput, key: string): string | undefined {
  const result = asRecord(value)?.[key];

  return isJsonString(result) ? result : undefined;
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
