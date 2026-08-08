import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  RunResult,
  RunStreamedResult,
  SandboxMode,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import type { JsonSchema } from "./json-types.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  isNativeSchemaUnsupportedFailure,
  ProviderSchemaUnsupportedError,
} from "./local-agent-errors.js";

export {
  isNativeSchemaUnsupportedFailure,
  isProviderSchemaUnsupportedError,
  ProviderSchemaUnsupportedError,
} from "./local-agent-errors.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  /** Provider-native effort / reasoning level (was thinking). */
  effort?: string;
  /** JSON Schema for native structured output (codex/claude). */
  schema?: JsonSchema;
}

export interface LocalAgentRunResult {
  provider: LocalAgentProvider;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
  /** Provider-native structured object when schema was requested. */
  structured?: unknown;
  usage?: LocalAgentUsageSnapshot;
}

export interface LocalAgentUsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  state: "partial" | "final";
}

export interface LocalAgentActivity {
  kind: "tool" | "command" | "file" | "status";
  status: "running" | "completed" | "failed";
  label: string;
  detail?: string;
}

export interface LocalAgentObserver {
  onSession?(providerSessionId: string): void;
  onUsage?(usage: LocalAgentUsageSnapshot): void;
  onActivity?(activity: LocalAgentActivity): void;
}

export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult>;
}

interface CodexThreadLike {
  readonly id: string | null;
  run(prompt: string, turnOptions?: TurnOptions): Promise<RunResult>;
  runStreamed?(prompt: string, turnOptions?: TurnOptions): Promise<RunStreamedResult>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexFactory = (options?: CodexOptions) => CodexClientLike;

function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): SandboxMode {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function threadOptionsFor(input: LocalAgentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspace,
    sandboxMode: sandboxModeFor(input.writeMode),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.effort as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly codex: CodexClientLike;

  constructor(codex: CodexClientLike) {
    this.codex = codex;
  }

  async run(input: LocalAgentRunInput, observer?: LocalAgentObserver): Promise<LocalAgentRunResult> {
    const options = threadOptionsFor(input);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    const turnOptions = input.schema ? { outputSchema: input.schema } : undefined;
    let turn: RunResult;
    const streamed = thread.runStreamed !== undefined;
    try {
      turn = thread.runStreamed
        ? await collectCodexStream(await thread.runStreamed(input.prompt, turnOptions), observer)
        : await thread.run(input.prompt, turnOptions);
    } catch (error) {
      if (input.schema && isNativeSchemaUnsupportedFailure(error)) {
        throw new ProviderSchemaUnsupportedError(this.provider, error);
      }
      throw error;
    }

    if (!streamed && thread.id) observer?.onSession?.(thread.id);
    const usage = turn.usage ? codexUsage(turn.usage) : undefined;
    if (usage) observer?.onUsage?.(usage);
    return {
      provider: this.provider,
      providerSessionId: thread.id,
      finalResponse: turn.finalResponse,
      items: turn.items,
      usage,
      ...(input.schema ? { structured: tryParseJson(turn.finalResponse) } : {}),
    };
  }
}

async function collectCodexStream(
  streamed: RunStreamedResult,
  observer?: LocalAgentObserver,
): Promise<RunResult> {
  const items: ThreadItem[] = [];
  let finalResponse = "";
  let usage: RunResult["usage"] = null;
  for await (const event of streamed.events) {
    if (event.type === "thread.started") observer?.onSession?.(event.thread_id);
    if (event.type === "item.started") notifyCodexItem(event.item, "running", observer);
    if (event.type === "item.completed") {
      items.push(event.item);
      notifyCodexItem(event.item, codexItemStatus(event.item), observer);
      if (event.item.type === "agent_message") finalResponse = event.item.text;
    }
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  return { items, finalResponse, usage };
}

function notifyCodexItem(
  item: ThreadItem,
  status: LocalAgentActivity["status"],
  observer?: LocalAgentObserver,
): void {
  const activity = codexItemActivity(item, status);
  if (activity) observer?.onActivity?.(activity);
}

function codexItemActivity(
  item: ThreadItem,
  status: LocalAgentActivity["status"],
): LocalAgentActivity | undefined {
  if (item.type === "command_execution") {
    return { kind: "command", status, label: item.command };
  }
  if (item.type === "file_change") {
    return {
      kind: "file",
      status,
      label: "apply file changes",
      detail: item.changes.map((change) => `${change.kind} ${change.path}`).join(", "),
    };
  }
  if (item.type === "mcp_tool_call") {
    return { kind: "tool", status, label: `${item.server}.${item.tool}` };
  }
  if (item.type === "web_search") return { kind: "tool", status, label: "web search", detail: item.query };
  return undefined;
}

function codexItemStatus(item: ThreadItem): LocalAgentActivity["status"] {
  if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "file_change") {
    return item.status === "failed" ? "failed" : "completed";
  }
  return "completed";
}

function codexUsage(usage: NonNullable<RunResult["usage"]>): LocalAgentUsageSnapshot {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    state: "final",
  };
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function createCodexSdkLocalAgentRuntime(
  options?: CodexOptions,
  codexFactory?: CodexFactory,
): Promise<CodexSdkLocalAgentRuntime> {
  const factory = codexFactory ?? (await defaultCodexFactory());
  return new CodexSdkLocalAgentRuntime(factory(options));
}

async function defaultCodexFactory(): Promise<CodexFactory> {
  const module = await import("@openai/codex-sdk");
  return (options) => new module.Codex(options) as Codex;
}
