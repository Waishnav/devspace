import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { Result, type Result as BetterResult } from "better-result";
import type {
  EffortLevel,
  OutputFormat,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonSchema } from "./json-types.js";
import {
  classifyAgentProviderError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import {
  createCodexSdkLocalAgentRuntime,
  isNativeSchemaUnsupportedFailure,
  ProviderSchemaUnsupportedError,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
  type LocalAgentActivity,
  type LocalAgentObserver,
  type LocalAgentUsageSnapshot,
} from "./local-agent-runtime.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS: Record<"cursor" | "copilot", [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
};
const PI_AGENT_TIMEOUT_MS = 120_000;

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  observer?: LocalAgentObserver,
): Promise<LocalAgentRunResult> {
  const result = await runLocalAgentProviderResult(provider, input, observer);
  if (result.isErr()) throw result.error;
  return result.value;
}

export async function runLocalAgentProviderResult(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  observer?: LocalAgentObserver,
): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
  return Result.tryPromise({
    try: () => createLocalAgentAdapter(provider).run(input, observer),
    catch: (cause) => classifyAgentProviderError(provider, cause),
  });
}

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const runtime = await createCodexSdkLocalAgentRuntime();
    return runtime.run(input, observer);
  }
}

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const claudeExecutable = process.env.CLAUDE_COMMAND ?? resolveExecutable("claude");
    try {
      const messages = query({
        prompt: input.prompt,
        options: {
          cwd: input.workspace,
          model: input.model,
          ...(input.effort
            ? { thinking: { type: "adaptive" } as const, effort: input.effort as EffortLevel }
            : {}),
          resume: input.providerSessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: claudeCommandEnvironment(process.env),
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
          ...claudeOutputFormatOptions(input.schema),
        },
      });

      let providerSessionId = input.providerSessionId ?? null;
      let finalResponse = "";
      let structured: unknown | undefined;
      const items: unknown[] = [];
      for await (const message of messages) {
        items.push(message);
        const record = message as Record<string, unknown>;
        if (typeof record.session_id === "string") {
          providerSessionId = record.session_id;
          observer?.onSession?.(record.session_id);
        }
        notifyClaudeActivity(record, observer);
        if (record.type !== "result") continue;
        const resultError = claudeResultError(record);
        if (resultError) throw new Error(resultError);
        const extracted = extractClaudeResultPayload(record);
        if (extracted) {
          finalResponse = extracted.finalResponse;
          structured = extracted.structured;
        }
        const usage = claudeUsage(record.usage, "final");
        if (usage) observer?.onUsage?.(usage);
      }

      finalResponse = requireFinalResponse("Claude", finalResponse);
      const usage = [...items]
        .reverse()
        .map((item) => claudeUsage((item as Record<string, unknown>).usage, "final"))
        .find((snapshot) => snapshot !== undefined);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
        items,
        ...(usage ? { usage } : {}),
        ...(structured !== undefined ? { structured } : {}),
      };
    } catch (error) {
      if (input.schema && isNativeSchemaUnsupportedFailure(error)) {
        throw new ProviderSchemaUnsupportedError(this.provider, error);
      }
      throw error;
    }
  }
}

function notifyClaudeActivity(record: Record<string, unknown>, observer?: LocalAgentObserver): void {
  if (record.type === "tool_progress" && typeof record.tool_name === "string") {
    observer?.onActivity?.({ kind: "tool", status: "running", label: record.tool_name });
    return;
  }
  if (record.type === "tool_use_summary" && typeof record.summary === "string") {
    observer?.onActivity?.({ kind: "tool", status: "completed", label: record.summary });
    return;
  }
  if (record.type !== "assistant") return;
  const message = record.message as { content?: unknown[] } | undefined;
  for (const block of message?.content ?? []) {
    const content = block as Record<string, unknown>;
    if (content.type !== "tool_use" || typeof content.name !== "string") continue;
    observer?.onActivity?.({
      kind: content.name === "Bash" ? "command" : content.name === "Write" || content.name === "Edit" ? "file" : "tool",
      status: "running",
      label: content.name,
      detail: claudeToolDetail(content.input),
    });
  }
}

function claudeToolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "query"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function claudeUsage(value: unknown, state: "partial" | "final"): LocalAgentUsageSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    cachedInputTokens: nonNegativeInteger(usage.cache_read_input_tokens),
    cacheCreationInputTokens: nonNegativeInteger(usage.cache_creation_input_tokens),
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    state,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Build Claude SDK outputFormat when a JSON Schema is requested. */
export function claudeOutputFormatOptions(
  schema: JsonSchema | undefined,
): { outputFormat: OutputFormat } | Record<string, never> {
  if (!schema) return {};
  return {
    outputFormat: {
      type: "json_schema",
      schema: schema as Record<string, unknown>,
    },
  };
}

/**
 * Prefer structured_output from a Claude result message; fall back to text result.
 * When only structured is present, stringify it for journal finalResponse.
 */
export function extractClaudeResultPayload(
  record: Record<string, unknown>,
): { finalResponse: string; structured?: unknown } | undefined {
  const hasStructured = Object.prototype.hasOwnProperty.call(record, "structured_output");
  const structured = hasStructured ? record.structured_output : undefined;
  const text = typeof record.result === "string" ? record.result : undefined;

  if (hasStructured && structured !== undefined) {
    return {
      finalResponse:
        text && text.trim()
          ? text
          : typeof structured === "string"
            ? structured
            : JSON.stringify(structured),
      structured,
    };
  }
  if (text !== undefined) {
    return { finalResponse: text };
  }
  return undefined;
}

function claudeResultError(record: Record<string, unknown>): string | undefined {
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

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveExecutable(command: string): string | undefined {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", [
    ...(process.platform === "win32" ? [command] : ["-v", command]),
  ], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
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

class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const { client, server } = await createOpencode();
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(client, input);
      observer?.onSession?.(sessionId);
      const promptResult = await promptOpencodeSession(client, sessionId, input);
      // The prompt response is scoped to this turn; the messages endpoint returns
      // the whole session and would reattribute historical tools on resume.
      const usage = observeOpenCodeResult(promptResult, observer);
      await waitForOpencodeSession(client, sessionId);
      const messages = await readOpencodeMessages(client, sessionId);
      const finalResponse = requireFinalResponse(
        "OpenCode",
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
        ...(usage ? { usage } : {}),
      };
    } finally {
      server.close();
    }
  }
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {}

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const { client } = await import("@agentclientprotocol/sdk");
    const { methods } = await import("@agentclientprotocol/sdk");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = this.command;
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      let providerSessionId = input.providerSessionId ?? null;
      const finalResponse = await client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .connectWith(stream, async (context) => {
          const session = await context.buildSession(input.workspace).start();
          providerSessionId = session.sessionId;
          observer?.onSession?.(session.sessionId);
          try {
            if (input.model) {
              const config = resolveAcpModelConfigUpdate(session, input.model, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            if (input.effort) {
              const config = resolveAcpEffortConfigUpdate(session, input.effort, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            const prompt = session.prompt(input.prompt);
            const textParts: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                const response = await prompt;
                const usage = tokenUsage(asRecord(response.usage), "final");
                if (usage) observer?.onUsage?.(usage);
                return textParts.join("").trim();
              }

              const update = message.update;
              observeAcpUpdate(update, observer);
              if (update.sessionUpdate === "agent_message_chunk") {
                const content = update.content;
                if (content.type === "text") textParts.push(content.text);
              }
            }
          } finally {
            session.dispose();
          }
        });
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse: finalResponse.trim(),
        items: [],
      };
    } catch (error) {
      throw new Error(`${this.provider} ACP run failed: ${errorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`);
    } finally {
      child.kill();
    }
  }
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
  });
}

export function resolveAcpEffortConfigUpdate(
  session: unknown,
  effort: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "effort option",
    provider,
    value: effort,
  });
}

/** @deprecated Use resolveAcpEffortConfigUpdate */
export const resolveAcpThinkingConfigUpdate = resolveAcpEffortConfigUpdate;

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session did not return session metadata.`);
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);

  const response = asRecord(record.newSessionResponse);
  const configOptions = response ? readArray(response, "configOptions") ?? [] : [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) {
    throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  }

  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);

  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value: options.value };
}

function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
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

function selectAcpAllowPermissionOption(options: Array<{ optionId: string; kind: string }>): { optionId: string } | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

class PiRpcLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--thinking", input.effort);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const child = spawn(process.env.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const rpc = new JsonLineRpc(child);
    const events: unknown[] = [];
    rpc.onEvent((event) => {
      events.push(event);
      observePiEvent(event, observer);
    });
    try {
      const state = await rpc.request({ type: "get_state" });
      const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
      if (providerSessionId) observer?.onSession?.(providerSessionId);
      const done = rpc.waitForEvent((event) => asRecord(event)?.type === "agent_end", PI_AGENT_TIMEOUT_MS);
      await rpc.request({ type: "prompt", message: input.prompt });
      const agentEnd = await done;
      const sessionMessages = await rpc.request({ type: "get_messages" });
      const finalResponse =
        extractPiFinalResponse(agentEnd) ||
        extractPiFinalResponse(sessionMessages) ||
        extractPiStreamingText(events);
      if (!finalResponse) {
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          extractPiProviderError(events);
        if (providerError) throw new Error(`Pi returned an error: ${providerError}`);
      }
      requireFinalResponse("Pi", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
        items: [...events, sessionMessages],
      };
    } finally {
      child.kill();
    }
  }
}

export function observeOpenCodeResult(
  value: unknown,
  observer?: LocalAgentObserver,
): LocalAgentUsageSnapshot | undefined {
  const messages = openCodeMessages(value);
  let usage: LocalAgentUsageSnapshot | undefined;
  for (const message of messages) {
    const info = asRecord(message.info) ?? message;
    if (info.role !== "assistant") continue;
    const snapshot = tokenUsage(asRecord(info.tokens), "final");
    if (snapshot) usage = snapshot;
    for (const partValue of readArray(message, "parts") ?? readArray(message, "content") ?? []) {
      const part = asRecord(partValue);
      if (part?.type !== "tool") continue;
      const state = asRecord(part.state);
      const status = normalizeActivityStatus(state?.status ?? part.status);
      observer?.onActivity?.({
        kind: toolKind(directString(part.tool) ?? directString(part.name)),
        status,
        label: directString(part.tool) ?? directString(part.name) ?? "tool",
      });
    }
  }
  if (usage) observer?.onUsage?.(usage);
  return usage;
}

export function observePiEvent(event: unknown, observer?: LocalAgentObserver): void {
  const record = asRecord(event);
  if (!record) return;
  const usage = tokenUsage(asRecord(record.usage) ?? asRecord(asRecord(record.message)?.usage), record.type === "agent_end" ? "final" : "partial");
  if (usage) observer?.onUsage?.(usage);
  const tool = asRecord(record.tool) ?? asRecord(record.toolCall) ?? asRecord(record.toolExecution);
  const name = directString(record.toolName) ?? directString(tool?.name);
  if (!name) return;
  const detail = directString(record.command) ?? directString(asRecord(tool?.arguments)?.command);
  observer?.onActivity?.({
    kind: toolKind(name),
    status: normalizeActivityStatus(record.status ?? tool?.status ?? (record.type === "tool_execution_end" ? "completed" : "running")),
    label: name,
    ...(detail ? { detail } : {}),
  });
}

export function observeAcpUpdate(update: unknown, observer?: LocalAgentObserver): void {
  const record = asRecord(update);
  if (!record) return;
  if (record.sessionUpdate === "usage_update") return;
  if (record.sessionUpdate !== "tool_call" && record.sessionUpdate !== "tool_call_update") return;
  const label = directString(record.title) ?? directString(record.kind) ?? "tool";
  observer?.onActivity?.({
    kind: acpToolKind(directString(record.kind)),
    status: normalizeActivityStatus(record.status),
    label,
  });
}

function openCodeMessages(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  const data = record?.data;
  const values = Array.isArray(data) ? data : data ? [data] : [];
  return values.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
}

function tokenUsage(
  value: Record<string, unknown> | undefined,
  state: "partial" | "final",
): LocalAgentUsageSnapshot | undefined {
  if (!value) return undefined;
  const inputTokens = nonNegativeInteger(value.input ?? value.input_tokens ?? value.inputTokens);
  const outputTokens = nonNegativeInteger(value.output ?? value.output_tokens ?? value.outputTokens);
  const explicitTotal = nonNegativeInteger(value.total ?? value.total_tokens ?? value.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && explicitTotal === undefined) return undefined;
  const cache = asRecord(value.cache);
  return {
    inputTokens,
    cachedInputTokens: nonNegativeInteger(cache?.read ?? value.cached_read_tokens),
    cacheCreationInputTokens: nonNegativeInteger(cache?.write ?? value.cache_creation_input_tokens),
    outputTokens,
    totalTokens: explicitTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    state,
  };
}

function normalizeActivityStatus(value: unknown): LocalAgentActivity["status"] {
  if (value === "failed" || value === "error") return "failed";
  if (value === "completed" || value === "complete" || value === "success") return "completed";
  return "running";
}

function toolKind(name: string | undefined): LocalAgentActivity["kind"] {
  const normalized = name?.toLowerCase();
  if (normalized === "bash" || normalized === "shell" || normalized === "command") return "command";
  if (normalized === "write" || normalized === "edit" || normalized === "patch") return "file";
  return "tool";
}

function acpToolKind(kind: string | undefined): LocalAgentActivity["kind"] {
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file";
  return "tool";
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;

  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: unknown) => void>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: unknown) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  waitForEvent(predicate: (event: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderr += `${line}\n`;
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${line}`));
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const sessionClient = client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  };
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSession(
  client: unknown,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  // OpenCode SessionPrompt accepts format: { type: 'json_schema', schema }, but
  // per-model support is not programmatically discoverable — workflow agent({ schema })
  // keeps the prompt+Ajv path for opencode (no native structured output here).
  const session = (client as {
    session: {
      prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session;
  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    prompt: { parts: [{ type: "text", text: input.prompt }] },
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
    ...(input.effort ? { variant: input.effort } : {}),
  };
  return session.prompt(promptInput, { throwOnError: true });
}

async function waitForOpencodeSession(client: unknown, sessionId: string): Promise<void> {
  const session = (client as {
    session?: { wait?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.wait) return;
  await session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(client: unknown, sessionId: string): Promise<unknown> {
  const session = (client as {
    session?: {
      messages?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
    };
  }).session;
  if (!session?.messages) return undefined;
  return session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

export function extractPiFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: unknown[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return typeof update.delta === "string" ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: unknown): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return typeof error === "string" ? error.trim() : "";
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function extractPiAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
