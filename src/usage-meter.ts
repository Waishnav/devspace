import { statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageContentMode } from "./config.js";

type TextContent = { type: "text"; text: string };
type ToolContent = TextContent | { type: "image"; data: string; mimeType: string };

export interface UsageBucket {
  observedTokens: number;
  savedTokens: number;
  calls: number;
  inputChars: number;
  outputChars: number;
  payloadChars: number;
  totalDurationMs: number;
  errorCalls: number;
  retries: number;
}

export interface UsageEntry {
  ts: string;
  sessionPid: number;
  workspaceId?: string;
  workspaceRoot?: string;
  workspaceName?: string;
  tool: string;
  path?: string;
  observedChars: number;
  observedTokens: number;
  savedChars: number;
  savedTokens: number;
  inputChars: number;
  outputChars: number;
  payloadChars: number;
  durationMs: number;
  error: boolean;
  retries: number;
  sessionObservedTokens: number;
  sessionSavedTokens: number;
  sessionDurationMs: number;
  sessionCalls: number;
  sessionErrors: number;
  sessionRetries: number;
  byTool: Record<string, UsageBucket>;
  note: string;
}

export interface ExecutionCostSnapshot {
  observedTokens: number;
  savedTokens: number;
  totalDurationMs: number;
  calls: number;
  errors: number;
  retries: number;
  byTool: Record<string, UsageBucket>;
  note: string;
}

const session = {
  observedTokens: 0,
  savedTokens: 0,
  totalDurationMs: 0,
  calls: 0,
  errors: 0,
  retries: 0,
  byTool: new Map<string, UsageBucket>(),
};
let historyWrite = Promise.resolve();

function historyPath(): string {
  return process.env.DEVSPACE_USAGE_HISTORY
    ?? join(homedir(), ".local", "share", "devspace", "usage-history.jsonl");
}

function clampNumber(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.ceil(Number(value)) : 0;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(clampNumber(chars) / 4);
}

export function textContentChars(content: ToolContent[]): number {
  return content
    .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
    .reduce((total, item) => total + item.text.length, 0);
}

export function estimateFileChars(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

export function editInputChars(edits: Array<{ oldText?: string; newText?: string }>): number {
  return edits.reduce(
    (total, edit) =>
      total + String(edit.oldText ?? "").length + String(edit.newText ?? "").length,
    0,
  );
}

export function compactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function compactDuration(durationMs: number): string {
  if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(1)}m`;
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${durationMs}ms`;
}

function byToolSnapshot(): Record<string, UsageBucket> {
  return Object.fromEntries(
    Array.from(session.byTool.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tool, bucket]) => [tool, { ...bucket }]),
  );
}

function appendHistory(entry: UsageEntry): void {
  const file = historyPath();
  historyWrite = historyWrite.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  }).catch(() => {
    // Diagnostic only. Never break the actual tool result.
  });
}

export function recordObservedToolUsage(input: {
  tool?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  path?: string;
  observedChars: number;
  savedChars: number;
  inputChars?: number;
  outputChars?: number;
  payloadChars?: number;
  durationMs?: number;
  error?: boolean;
  retries?: number;
}): UsageEntry {
  const tool = input.tool ?? "unknown";
  const observedChars = clampNumber(input.observedChars);
  const savedChars = clampNumber(input.savedChars);
  const observedTokens = estimateTokensFromChars(observedChars);
  const savedTokens = estimateTokensFromChars(savedChars);
  const inputChars = clampNumber(input.inputChars);
  const outputChars = clampNumber(input.outputChars);
  const payloadChars = clampNumber(input.payloadChars ?? observedChars);
  const durationMs = clampNumber(input.durationMs);
  const retries = clampNumber(input.retries);
  const error = input.error === true;
  const current = session.byTool.get(tool) ?? {
    observedTokens: 0,
    savedTokens: 0,
    calls: 0,
    inputChars: 0,
    outputChars: 0,
    payloadChars: 0,
    totalDurationMs: 0,
    errorCalls: 0,
    retries: 0,
  };

  current.observedTokens += observedTokens;
  current.savedTokens += savedTokens;
  current.calls += 1;
  current.inputChars += inputChars;
  current.outputChars += outputChars;
  current.payloadChars += payloadChars;
  current.totalDurationMs += durationMs;
  current.errorCalls += error ? 1 : 0;
  current.retries += retries;
  session.byTool.set(tool, current);
  session.observedTokens += observedTokens;
  session.savedTokens += savedTokens;
  session.totalDurationMs += durationMs;
  session.calls += 1;
  session.errors += error ? 1 : 0;
  session.retries += retries;

  const entry: UsageEntry = {
    ts: new Date().toISOString(),
    sessionPid: process.pid,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    workspaceName: input.workspaceRoot
      ? String(input.workspaceRoot).split("/").filter(Boolean).at(-1)
      : undefined,
    tool,
    path: input.path,
    observedChars,
    observedTokens,
    savedChars,
    savedTokens,
    inputChars,
    outputChars,
    payloadChars,
    durationMs,
    error,
    retries,
    sessionObservedTokens: session.observedTokens,
    sessionSavedTokens: session.savedTokens,
    sessionDurationMs: session.totalDurationMs,
    sessionCalls: session.calls,
    sessionErrors: session.errors,
    sessionRetries: session.retries,
    byTool: byToolSnapshot(),
    note: "DevSpace observed execution estimate only. Not host-model billing or actual model usage.",
  };
  appendHistory(entry);
  return entry;
}

export function getExecutionCostSnapshot(): ExecutionCostSnapshot {
  return {
    observedTokens: session.observedTokens,
    savedTokens: session.savedTokens,
    totalDurationMs: session.totalDurationMs,
    calls: session.calls,
    errors: session.errors,
    retries: session.retries,
    byTool: byToolSnapshot(),
    note: "Text-token values are estimates; duration and call/error counts are observed by DevSpace.",
  };
}

function fullUsageSummaryText(entry: UsageEntry): string {
  const byTool = Object.entries(entry.byTool)
    .map(([tool, value]) => `${tool} ${value.calls} calls/${compactDuration(value.totalDurationMs)}`)
    .join(" / ");

  return [
    "Execution cost estimate:",
    `Current: ~${compactTokenCount(entry.observedTokens)} tokens / ${compactDuration(entry.durationMs)} / ${entry.error ? "error" : "ok"}`,
    `Session: ~${compactTokenCount(entry.sessionObservedTokens)} tokens / ${compactDuration(entry.sessionDurationMs)} / ${entry.sessionCalls} calls / ${entry.sessionErrors} errors / ${entry.sessionRetries} retries`,
    `By tool: ${byTool || "none"}`,
    `Estimated saved tokens: ~${compactTokenCount(entry.sessionSavedTokens)}`,
    "Token values are estimated from text handled by DevSpace, not actual host-model usage.",
  ].join("\n");
}

function compactUsageSummaryText(entry: UsageEntry): string {
  return `DevSpace cost: ~${compactTokenCount(entry.observedTokens)} tok · ${compactDuration(entry.durationMs)} | session ~${compactTokenCount(entry.sessionObservedTokens)} tok · ${entry.sessionCalls} calls · ${entry.sessionErrors} errors`;
}

export function appendUsageToContent<T extends ToolContent>(
  content: T[],
  entry: UsageEntry,
  mode: UsageContentMode,
): ToolContent[] {
  if (mode === "off") return content;
  const text = mode === "full"
    ? fullUsageSummaryText(entry)
    : compactUsageSummaryText(entry);
  return [...content, { type: "text", text }];
}
