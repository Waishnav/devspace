/**
 * Cost statistics — PR #69 (selective: E. 执行成本统计).
 *
 * Records per-tool execution metrics with bounded rolling storage.
 * Does NOT record user file contents, only metadata.
 *
 * Tracked per tool invocation:
 *  - tool name
 *  - duration (ms)
 *  - returned characters (after truncation)
 *  - characters before truncation
 *  - whether truncation occurred
 *  - error count
 *  - retry count
 *  - approximate token count
 *  - session-level tool call counter
 *
 * Storage is bounded (default 1000 entries, rolling).
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export interface ToolCallRecord {
  tool: string;
  startTime: number;
  durationMs: number;
  returnedChars: number;
  originalChars: number;
  truncated: boolean;
  error: boolean;
  retries: number;
  approxTokens: number;
  sessionId?: string;
}

export interface CostSummary {
  totalCalls: number;
  totalErrors: number;
  totalRetries: number;
  totalDurationMs: number;
  totalReturnedChars: number;
  totalOriginalChars: number;
  totalTruncatedCalls: number;
  approxTotalTokens: number;
  perTool: Array<{
    tool: string;
    calls: number;
    errors: number;
    avgDurationMs: number;
    totalReturnedChars: number;
    truncatedCalls: number;
  }>;
  recentCalls: ToolCallRecord[];
}

const DEFAULT_MAX_RECORDS = 1000;

// Rough approximation: 1 token ≈ 4 characters for English, ≈ 2 for CJK.
// We use a blended 3.5 chars/token as a rough heuristic.
const CHARS_PER_TOKEN = 3.5;

export class CostTracker {
  private records: ToolCallRecord[] = [];
  private readonly maxRecords: number;
  private sessionCallCount = new Map<string, number>();

  constructor(maxRecords: number = DEFAULT_MAX_RECORDS) {
    this.maxRecords = maxRecords;
  }

  /** Record a completed tool call. */
  record(call: Omit<ToolCallRecord, "approxTokens"> & { approxTokens?: number }): void {
    const approxTokens = call.approxTokens ?? Math.round(call.returnedChars / CHARS_PER_TOKEN);
    const entry: ToolCallRecord = { ...call, approxTokens };
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    if (call.sessionId) {
      this.sessionCallCount.set(
        call.sessionId,
        (this.sessionCallCount.get(call.sessionId) ?? 0) + 1,
      );
    }
  }

  /** Get the number of tool calls in a session. */
  getSessionCallCount(sessionId: string): number {
    return this.sessionCallCount.get(sessionId) ?? 0;
  }

  /** Get a summary of all recorded calls. */
  getSummary(): CostSummary {
    const perToolMap = new Map<string, {
      calls: number;
      errors: number;
      totalDurationMs: number;
      totalReturnedChars: number;
      truncatedCalls: number;
    }>();

    let totalCalls = 0;
    let totalErrors = 0;
    let totalRetries = 0;
    let totalDurationMs = 0;
    let totalReturnedChars = 0;
    let totalOriginalChars = 0;
    let totalTruncatedCalls = 0;
    let approxTotalTokens = 0;

    for (const r of this.records) {
      totalCalls++;
      totalErrors += r.error ? 1 : 0;
      totalRetries += r.retries;
      totalDurationMs += r.durationMs;
      totalReturnedChars += r.returnedChars;
      totalOriginalChars += r.originalChars;
      totalTruncatedCalls += r.truncated ? 1 : 0;
      approxTotalTokens += r.approxTokens;

      const existing = perToolMap.get(r.tool) ?? {
        calls: 0,
        errors: 0,
        totalDurationMs: 0,
        totalReturnedChars: 0,
        truncatedCalls: 0,
      };
      existing.calls++;
      existing.errors += r.error ? 1 : 0;
      existing.totalDurationMs += r.durationMs;
      existing.totalReturnedChars += r.returnedChars;
      existing.truncatedCalls += r.truncated ? 1 : 0;
      perToolMap.set(r.tool, existing);
    }

    const perTool = [...perToolMap.entries()]
      .map(([tool, stats]) => ({
        tool,
        calls: stats.calls,
        errors: stats.errors,
        avgDurationMs: stats.calls > 0 ? Math.round(stats.totalDurationMs / stats.calls) : 0,
        totalReturnedChars: stats.totalReturnedChars,
        truncatedCalls: stats.truncatedCalls,
      }))
      .sort((a, b) => b.calls - a.calls);

    return {
      totalCalls,
      totalErrors,
      totalRetries,
      totalDurationMs,
      totalReturnedChars,
      totalOriginalChars,
      totalTruncatedCalls,
      approxTotalTokens,
      perTool,
      recentCalls: this.records.slice(-20),
    };
  }

  /** Clear all records (for testing or reset). */
  clear(): void {
    this.records = [];
    this.sessionCallCount.clear();
  }

  /** Current record count. */
  get size(): number {
    return this.records.length;
  }
}

/**
 * Safe PATH supplement — PR #69 (selective: F. 安全 PATH 补充).
 *
 * On Windows, adds known-safe and commonly-needed paths to PATH
 * without overwriting the user's existing PATH. Only appends missing entries.
 *
 * Added paths:
 *  - Node.js directory
 *  - npm global bin
 *  - Git cmd directory
 *  - PowerShell (System32\WindowsPowerShell\v1.0)
 *  - Windows System32
 *
 * Does NOT read or execute .zshrc, .zprofile, bash profile, or unknown startup scripts.
 */
export function supplementSafePath(currentPath: string): string {
  if (process.platform !== "win32") return currentPath;

  // path (dirname, join) and fs (existsSync) imported at module level
  const existing = currentPath.split(";").map((p) => p.toLowerCase().replace(/\\$/, ""));

  const candidates: string[] = [];

  // Node.js directory
  const nodeDir = dirname(process.execPath);
  candidates.push(nodeDir);

  // npm global bin
  const npmGlobal = join(process.env.APPDATA ?? "", "npm");
  candidates.push(npmGlobal);

  // Git cmd (typical install locations)
  const gitCandidates = [
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files (x86)\\Git\\cmd",
  ];
  for (const gc of gitCandidates) candidates.push(gc);

  // PowerShell
  candidates.push("C:\\Windows\\System32\\WindowsPowerShell\\v1.0");

  // Windows System32
  candidates.push("C:\\Windows\\System32");

  const toAdd: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const cl = c.toLowerCase().replace(/\\$/, "");
    if (existing.includes(cl)) continue;
    if (!existsSync(c)) continue;
    toAdd.push(c);
  }

  if (toAdd.length === 0) return currentPath;
  return currentPath + (currentPath.endsWith(";") ? "" : ";") + toAdd.join(";");
}
