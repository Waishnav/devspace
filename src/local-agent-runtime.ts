import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRuntime {
  readonly provider: string;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

export interface CodexCliInvocation {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
}

export interface CodexCliTurn {
  readonly threadId: string | null;
  readonly finalResponse: string;
  readonly items: unknown[];
}

export type CodexCliRunner = (
  invocation: CodexCliInvocation,
) => Promise<CodexCliTurn>;

export interface CodexCliRuntimeOptions {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly version?: string;
  readonly runner?: CodexCliRunner;
}

interface ParsedCodexCliLines {
  threadId: string | null;
  finalResponse: string;
  items: unknown[];
  failure: unknown;
}

const CODEX_APPROVAL_POLICY = "never";

export function codexCliArguments(input: LocalAgentRunInput): string[] {
  const args = ["exec", "--experimental-json"];
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.thinking) {
    args.push("--config", `model_reasoning_effort="${input.thinking}"`);
  }
  args.push("--config", `approval_policy="${CODEX_APPROVAL_POLICY}"`);
  args.push("--sandbox", sandboxModeFor(input.writeMode));
  args.push("--cd", input.workspace);
  if (input.providerSessionId) {
    args.push("resume", input.providerSessionId);
  }
  return args;
}

// Mirror the SDK's event handling, minus the parts DevSpace does not use:
// `thread.started` supplies the thread id, `item.completed` yields the final
// agent message and the item log, and a `turn.failed` event aborts the run.
export function parseCodexCliLines(lines: string[]): ParsedCodexCliLines {
  let threadId: string | null = null;
  let finalResponse = "";
  const items: unknown[] = [];
  let failure: unknown;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Failed to parse codex CLI output line: ${line.slice(0, 200)}`);
    }
    switch (event.type) {
      case "thread.started": {
        if (typeof event.thread_id === "string") threadId = event.thread_id;
        break;
      }
      case "item.completed": {
        const record = event.item as Record<string, unknown> | undefined;
        if (record) items.push(record);
        if (record?.type === "agent_message" && typeof record.text === "string") {
          finalResponse = record.text;
        }
        break;
      }
      case "turn.failed": {
        failure = failureMessage(event.error);
        break;
      }
    }
  }
  return { threadId, finalResponse, items, failure };
}

export class CodexCliLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly runner: CodexCliRunner;

  constructor(private readonly options: CodexCliRuntimeOptions) {
    this.runner = options.runner ?? createCodexCliSpawnRunner({ version: options.version });
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const turn = await this.runner({
      command: this.options.command,
      args: codexCliArguments(input),
      env: this.options.env,
      prompt: input.prompt,
    });
    return {
      provider: this.provider,
      providerSessionId: turn.threadId,
      finalResponse: turn.finalResponse,
      items: turn.items,
    };
  }
}

export function createCodexCliLocalAgentRuntime(
  options: CodexCliRuntimeOptions,
): CodexCliLocalAgentRuntime {
  return new CodexCliLocalAgentRuntime(options);
}

export function createCodexCliSpawnRunner(options: { version?: string } = {}): CodexCliRunner {
  const version = options.version;
  return async (invocation) => {
    const { command, args, env, prompt } = invocation;
    const child = spawn(command, args, {
      env,
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    let stderr = "";
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    child.once("error", (error) => {
      spawnError = error;
    });
    if (!child.stdin) {
      child.kill();
      throw codexCliError("codex CLI did not expose stdin", version);
    }
    child.stdin.write(prompt);
    child.stdin.end();
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }
    const output = child.stdout;
    if (!output) {
      child.kill();
      throw codexCliError("codex CLI did not expose stdout", version);
    }
    const lines: string[] = [];
    const reader = createInterface({
      input: output,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of reader) {
        lines.push(line);
      }
    } finally {
      reader.close();
    }
    if (spawnError) {
      throw codexCliError(
        `Failed to start codex CLI: ${spawnError.message}`,
        version,
        stderr,
      );
    }

    const parsed = parseCodexCliLines(lines);
    if (parsed.failure) {
      throw codexCliError(`codex turn failed: ${String(parsed.failure)}`, version, stderr);
    }
    const { code, signal } = await exitPromise;
    if (code !== 0 || signal) {
      throw codexCliError(
        `codex CLI exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}`,
        version,
        stderr,
      );
    }
    return {
      threadId: parsed.threadId,
      finalResponse: parsed.finalResponse,
      items: parsed.items,
    };
  };
}

// Surface the CLI version and raw stderr in the exception so the session error
// row lets the host reason about model gates without forensics.
export function codexCliError(message: string, version?: string, stderr?: string): Error {
  const details = [
    message,
    version ? `codex version: ${version}` : undefined,
    stderr && stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n");
  return new Error(details);
}

function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): string {
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

function failureMessage(error: unknown): unknown {
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return error;
}