import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  RunResult,
  SandboxMode,
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
}

export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

interface CodexThreadLike {
  readonly id: string | null;
  run(prompt: string, turnOptions?: TurnOptions): Promise<RunResult>;
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

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const options = threadOptionsFor(input);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    const turnOptions = input.schema ? { outputSchema: input.schema } : undefined;
    let turn: RunResult;
    try {
      turn = await thread.run(input.prompt, turnOptions);
    } catch (error) {
      if (input.schema && isNativeSchemaUnsupportedFailure(error)) {
        throw new ProviderSchemaUnsupportedError(this.provider, error);
      }
      throw error;
    }

    return {
      provider: this.provider,
      providerSessionId: thread.id,
      finalResponse: turn.finalResponse,
      items: turn.items,
      ...(input.schema ? { structured: tryParseJson(turn.finalResponse) } : {}),
    };
  }
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
