import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import {
  localAgentMcpLaunchFromContext,
  type LocalAgentMcpLaunch,
} from "./local-agent-mcp-launch.js";
import {
  PiRpcConnection,
  parsePiModelSlug,
  piRecordString,
  type PiRpcRecord,
} from "./local-agent-pi-rpc.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const require = createRequire(import.meta.url);
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const PI_ALLOWED_TOOLS = [...PI_READ_ONLY_TOOLS, "edit", "write", "bash"] as const;
const PI_TURN_TIMEOUT_MS = 5 * 60_000;
const PI_STATE_POLL_MS = 200;
const MAX_PI_EVENTS = 10_000;

export interface PiRpcRuntimeConnection {
  request(record: PiRpcRecord, timeoutMs?: number): Promise<unknown>;
  send(record: PiRpcRecord): Promise<void>;
  nextEvent(timeoutMs?: number): Promise<PiRpcRecord | undefined>;
  isAlive(): boolean;
  close(): void;
}

export type PiRpcFactory = (
  context: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv,
) => Promise<{ connection: PiRpcRuntimeConnection; cleanup?: () => Promise<void> }>;

export class PiRpcRuntime implements LocalAgentRuntime {
  readonly provider = "pi" as const;
  private sessionFile?: string;
  private closed = false;

  constructor(
    private readonly connection: PiRpcRuntimeConnection,
    private readonly cleanup?: () => Promise<void>,
  ) {}

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
            message: "Pi RPC process is not running.",
          });
        }

        const providerSessionId = await this.ensureSession(input.providerSessionId);
        await callbacks?.onSessionId?.(providerSessionId);
        await this.applyOverrides(input);

        const events: PiRpcRecord[] = [];
        const removeAbort = bindLocalAgentAbort(input.signal, async () => {
          await this.connection.request({ type: "abort" }, 2_000).catch(() => undefined);
        });
        try {
          await this.connection.request({ type: "prompt", message: input.prompt });
          await this.waitForSettlement(events, input.signal);
          if (input.signal?.aborted) throw localAgentCancelledError("pi", "run");
          const response = await this.connection.request({ type: "get_last_assistant_text" });
          const finalResponse = piRecordString(response, "text")?.trim();
          if (!finalResponse) {
            const providerError = extractPiProviderError(events);
            if (providerError) {
              throw new AgentProviderExecutionError({
                code: "PROVIDER_EXECUTION_ERROR",
                provider: "pi",
                operation: "run",
                retryable: false,
                cause: new Error(providerError),
                message: "Pi agent turn failed.",
              });
            }
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: "pi",
              operation: "run",
              retryable: false,
              message: "Pi did not return a final assistant response.",
            });
          }
          return {
            provider: this.provider,
            providerSessionId,
            finalResponse,
            items: events,
          };
        } catch (cause) {
          if (input.signal?.aborted) throw localAgentCancelledError("pi", "run", cause);
          throw cause;
        } finally {
          removeAbort();
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // Pi owns durable session files independently of this process.
  }

  isAlive(): boolean {
    return !this.closed && this.connection.isAlive();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    await this.cleanup?.();
  }

  private async ensureSession(providerSessionId?: string): Promise<string> {
    if (providerSessionId && this.sessionFile !== providerSessionId) {
      const result = await this.connection.request({ type: "switch_session", sessionPath: providerSessionId });
      if (recordBoolean(result, "cancelled")) {
        throw piProtocolError("resume_session", "A Pi extension cancelled the session switch.");
      }
      this.sessionFile = undefined;
    } else if (!providerSessionId && !this.sessionFile) {
      const result = await this.connection.request({ type: "new_session" });
      if (recordBoolean(result, "cancelled")) {
        throw piProtocolError("create_session", "A Pi extension cancelled new session creation.");
      }
    }
    if (this.sessionFile) return this.sessionFile;
    const state = await this.connection.request({ type: "get_state" });
    const sessionFile = piRecordString(state, "sessionFile");
    if (!sessionFile) {
      throw piProtocolError("resolve_session", "Pi get_state returned no persisted session file.");
    }
    this.sessionFile = sessionFile;
    return sessionFile;
  }

  private async applyOverrides(input: LocalAgentRunInput): Promise<void> {
    if (input.model) {
      const model = await this.resolveModel(input.model);
      await this.connection.request({ type: "set_model", provider: model.provider, modelId: model.modelId });
    }
    if (input.effort) {
      await this.connection.request({ type: "set_thinking_level", level: input.effort });
    }
  }

  private async resolveModel(model: string): Promise<{ provider: string; modelId: string }> {
    const parsed = parsePiModelSlug(model);
    if (parsed) return parsed;
    const available = await this.connection.request({ type: "get_available_models" });
    const models = recordArray(available, "models");
    const matches = models.filter((entry) => piRecordString(entry, "id") === model);
    if (matches.length === 1) {
      const provider = piRecordString(matches[0], "provider");
      const modelId = piRecordString(matches[0], "id");
      if (provider && modelId) return { provider, modelId };
    }
    throw piProtocolError("configure_model", `Pi model not found or ambiguous: ${model}.`);
  }

  private async waitForSettlement(events: PiRpcRecord[], signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + PI_TURN_TIMEOUT_MS;
    let sawAgentActivity = false;
    for (;;) {
      if (signal?.aborted) return;
      if (Date.now() >= deadline) {
        throw piProtocolError("prompt", "Pi did not settle before the provider timeout.", true);
      }
      const event = await this.connection.nextEvent(PI_STATE_POLL_MS);
      if (event) {
        if (events.length >= MAX_PI_EVENTS) events.shift();
        events.push(event);
        if (event.type === "agent_start" || event.type === "message_start" || event.type === "tool_execution_start") {
          sawAgentActivity = true;
        }
        if (event.type === "extension_ui_request") {
          await cancelPiUiRequest(this.connection, event);
          continue;
        }
        if (event.type === "agent_settled") return;
        continue;
      }
      const state = await this.connection.request({ type: "get_state" }, 2_000);
      const streaming = recordBoolean(state, "isStreaming");
      const compacting = recordBoolean(state, "isCompacting");
      const pending = recordNumber(state, "pendingMessageCount") ?? 0;
      if (!streaming && !compacting && pending === 0 && !sawAgentActivity) return;
    }
  }
}

export class PiLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "pi" as const;
  readonly providerInstanceId = "pi";
  readonly runtimePolicy = {
    scope: "agent",
    authority: "write_mode",
    idleTimeoutMs: 3 * 60_000,
  } as const;
  readonly capabilities = {
    sessions: { resume: true, close: false },
    turns: { interrupt: true },
    configuration: { modelOverride: true, effortOverride: true },
    permissions: { enforcement: "client-boundary" },
    mcp: { supported: true },
  } as const;

  constructor(
    private readonly factory: PiRpcFactory = defaultPiRpcFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const { connection, cleanup } = await this.factory(context, this.env);
        return new PiRpcRuntime(connection, cleanup);
      },
    });
  }
}

async function defaultPiRpcFactory(
  context: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv,
): Promise<{ connection: PiRpcRuntimeConnection; cleanup?: () => Promise<void> }> {
  const launch = resolvePiCommand(env);
  const writeMode = context.writeMode ?? "allowed";
  const sandbox = writeMode === "full_access"
    ? undefined
    : await materializePiSandboxExtension(context.workspaceRoot, writeMode);
  const mcp = localAgentMcpLaunchFromContext(context, env);
  const mcpExtension = mcp ? await materializePiMcpExtension(mcp) : undefined;
  const args = [
    ...launch.args,
    "--mode",
    "rpc",
    "--approve",
    ...(writeMode === "full_access" ? [] : ["--extension", sandbox!.path]),
    ...(mcpExtension ? ["--extension", mcpExtension.path] : []),
    ...(writeMode === "read_only"
      ? ["--tools", PI_READ_ONLY_TOOLS.join(",")]
      : writeMode === "allowed"
        ? ["--tools", PI_ALLOWED_TOOLS.join(",")]
        : []),
  ];
  try {
    return {
      connection: PiRpcConnection.spawn({
        command: launch.command,
        args,
        cwd: context.workspaceRoot,
        env,
      }),
      ...((sandbox || mcpExtension)
        ? {
            cleanup: async () => {
              await sandbox?.cleanup();
              await mcpExtension?.cleanup();
            },
          }
        : {}),
    };
  } catch (error) {
    await sandbox?.cleanup();
    await mcpExtension?.cleanup();
    throw error;
  }
}

function resolvePiCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const configured = env.PI_COMMAND?.trim();
  if (configured) {
    const command = resolveExecutableCommand(configured, env);
    if (!command) throw new Error(`Pi executable not found: ${configured}`);
    return { command, args: [] };
  }
  const system = resolveExecutableCommand("pi", env);
  if (system) return { command: system, args: [] };
  const packageJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
  const cli = join(dirname(packageJson), "dist", "cli.js");
  return { command: process.execPath, args: [cli] };
}

async function materializePiSandboxExtension(
  workspaceRoot: string,
  writeMode: "read_only" | "allowed",
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "devspace-pi-"));
  const extensionPath = join(directory, "devspace-sandbox.ts");
  const jsModule = new URL("./local-agent-pi-sandbox.js", import.meta.url);
  const tsModule = new URL("./local-agent-pi-sandbox.ts", import.meta.url);
  const moduleUrl = existsSync(fileURLToPath(jsModule)) ? jsModule : tsModule;
  const source = [
    `import { createPiSandboxExtension, createPiSandboxModeRef } from ${JSON.stringify(moduleUrl.href)};`,
    `export default createPiSandboxExtension(${JSON.stringify(resolve(workspaceRoot))}, createPiSandboxModeRef(${JSON.stringify(writeMode)}));`,
    "",
  ].join("\n");
  await writeFile(extensionPath, source, "utf8");
  return {
    path: extensionPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function materializePiMcpExtension(
  launch: LocalAgentMcpLaunch,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "devspace-pi-mcp-"));
  const extensionPath = join(directory, "devspace-agents.ts");
  const jsModule = new URL("./local-agent-pi-mcp.js", import.meta.url);
  const tsModule = new URL("./local-agent-pi-mcp.ts", import.meta.url);
  const moduleUrl = existsSync(fileURLToPath(jsModule)) ? jsModule : tsModule;
  const source = [
    `import { createPiMcpBridgeExtension } from ${JSON.stringify(moduleUrl.href)};`,
    `export default createPiMcpBridgeExtension(${JSON.stringify(launch)});`,
    "",
  ].join("\n");
  await writeFile(extensionPath, source, "utf8");
  return {
    path: extensionPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function cancelPiUiRequest(connection: PiRpcRuntimeConnection, event: PiRpcRecord): Promise<void> {
  if (typeof event.id !== "string") return;
  if (event.method === "notify" || event.method === "setStatus" || event.method === "setWidget" || event.method === "setTitle") return;
  await connection.send({ type: "extension_ui_response", id: event.id, cancelled: true });
}

export function extractPiFinalResponse(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const root = value as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  const messages = Array.isArray(data.messages) ? data.messages : [data];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block): block is { type: string; text: string } => (
        Boolean(block)
        && typeof block === "object"
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ))
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function extractPiProviderError(value: unknown): string | undefined {
  const records = Array.isArray(value) ? [...value] : [value];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).messages;
    if (Array.isArray(nested)) records.push(...nested);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || typeof record !== "object") continue;
    const event = record as Record<string, unknown>;
    if (event.type === "extension_error" && typeof event.error === "string") return event.error;
    if (event.type === "message_end") {
      const message = event.message;
      if (message && typeof message === "object") {
        const error = (message as Record<string, unknown>).errorMessage;
        if (typeof error === "string" && error) return error;
      }
    }
    if (event.stopReason === "error" && typeof event.errorMessage === "string" && event.errorMessage) {
      return event.errorMessage;
    }
  }
  return undefined;
}

function recordBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}

function recordNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}

function recordArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result = (value as Record<string, unknown>)[key];
  return Array.isArray(result) ? result : [];
}

function piProtocolError(operation: string, message: string, retryable = false): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "pi",
    operation,
    retryable,
    message,
  });
}
