import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecutorConfig {
  command: string;
  baseUrl?: string;
  timeoutMs: number;
}

interface ExecutorResult {
  result: string;
  parsed?: unknown;
}

function baseUrlArgs(config: ExecutorConfig): string[] {
  return config.baseUrl ? ["--base-url", config.baseUrl] : [];
}

async function runExecutor(config: ExecutorConfig, args: string[]): Promise<ExecutorResult> {
  try {
    const { stdout, stderr } = await execFileAsync(config.command, args, {
      timeout: config.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (!output) return { result: "" };
    try {
      return {
        result: JSON.stringify(JSON.parse(output), null, 2),
        parsed: JSON.parse(output),
      };
    } catch {
      return { result: output };
    }
  } catch (error) {
    const maybe = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    const output = [maybe.stdout, maybe.stderr].filter(Boolean).join("\n").trim();
    const message = output || maybe.message || String(error);
    throw new Error(`executor ${args.join(" ")} failed${maybe.code ? ` (${maybe.code})` : ""}: ${message}`);
  }
}

export async function listExecutorSources(config: ExecutorConfig): Promise<ExecutorResult> {
  return runExecutor(config, ["tools", "sources", ...baseUrlArgs(config)]);
}

export async function searchExecutorTools(
  config: ExecutorConfig,
  input: { query: string; limit?: number },
): Promise<ExecutorResult> {
  return runExecutor(config, [
    "tools",
    "search",
    input.query,
    "--limit",
    String(input.limit ?? 20),
    ...baseUrlArgs(config),
  ]);
}

export async function callExecutorTool(
  config: ExecutorConfig,
  input: { path: string; arguments?: unknown },
): Promise<ExecutorResult> {
  const segments = input.path.split(".").map((part) => part.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new Error("Executor tool path must have at least two dot-separated segments, such as zotero.user.default.zotero_list_collections.");
  }

  return runExecutor(config, [
    "call",
    ...segments,
    JSON.stringify(input.arguments ?? {}),
    ...baseUrlArgs(config),
  ]);
}
