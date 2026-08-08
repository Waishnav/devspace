import type {
  LocalAgentActivityObservation,
  LocalAgentObservation,
  LocalAgentTokenUsage,
  LocalAgentToolStatus,
} from "./local-agent-observations.js";

/** Structural provider parsers kept independent from each SDK's type surface. */

export function extractCodexObservations(value: unknown): LocalAgentObservation[] {
  return extractArray(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const type = stringValue(record, ["type", "item_type"]) ?? "";
    if (!/(tool|command|mcp|function)/i.test(type) && !hasAny(record, ["tool_name", "toolName", "command"])) {
      return [];
    }
    return [activityFromRecord(record, type || "tool")];
  });
}

export function extractCodexUsage(value: unknown): LocalAgentTokenUsage | undefined {
  return findUsage(value, ["usage", "token_usage", "tokens"]);
}

export function extractClaudeObservations(value: unknown): LocalAgentObservation[] {
  return extractArray(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const type = stringValue(record, ["type"]) ?? "";
    const content = Array.isArray(record.content) ? record.content : [];
    const results: LocalAgentObservation[] = [];
    for (const part of content) {
      const partRecord = asRecord(part);
      if (!partRecord) continue;
      const partType = stringValue(partRecord, ["type"]) ?? "";
      if (partType === "tool_use") {
        results.push({
          kind: "activity",
          activityId: stringValue(partRecord, ["id", "tool_use_id"]),
          toolName: stringValue(partRecord, ["name", "tool_name"]) ?? "tool",
          toolStatus: "started",
          detail: stringifyDetail(partRecord.input),
        });
      } else if (partType === "tool_result") {
        results.push({
          kind: "activity",
          activityId: stringValue(partRecord, ["tool_use_id", "id"]),
          toolName: "tool",
          toolStatus: partRecord.is_error === true ? "failed" : "completed",
          detail: stringifyDetail(partRecord.content),
        });
      }
    }
    if (type === "tool_progress" || type === "tool_use") {
      results.push(activityFromRecord(record, type));
    }
    return results;
  });
}

export function extractClaudeUsage(value: unknown): LocalAgentTokenUsage | undefined {
  const direct = findUsage(value, ["usage", "token_usage", "tokens"]);
  if (direct) return direct;
  const record = asRecord(value);
  const modelUsage = asRecord(record?.modelUsage ?? record?.model_usage);
  if (!modelUsage) return undefined;
  const totals: LocalAgentTokenUsage = {};
  for (const model of Object.values(modelUsage)) {
    const usage = normalizeUsage(model);
    if (!usage) continue;
    addUsage(totals, usage);
  }
  return Object.keys(totals).length ? totals : undefined;
}

export function extractOpenCodeObservations(value: unknown): LocalAgentObservation[] {
  const root = unwrap(value);
  const messages = Array.isArray(root) ? root : arrayValue(asRecord(root), "messages");
  const records = messages ?? (asRecord(root) ? [root] : []);
  const output: LocalAgentObservation[] = [];
  for (const message of records) {
    const messageRecord = asRecord(message);
    if (!messageRecord) continue;
    const parts = arrayValue(messageRecord, "parts") ?? arrayValue(messageRecord, "content") ?? [];
    for (const part of parts) {
      const partRecord = asRecord(part);
      if (!partRecord || stringValue(partRecord, ["type"]) !== "tool") continue;
      const state = asRecord(partRecord.state) ?? partRecord;
      output.push({
        kind: "activity",
        activityId: stringValue(partRecord, ["callID", "callId", "id"]) ?? stringValue(state, ["callID", "callId", "id"]),
        toolName: stringValue(partRecord, ["tool", "name"]) ?? "tool",
        toolStatus: mapToolStatus(stringValue(state, ["status"]) ?? "updated"),
        detail: stringifyDetail(state.output ?? state.error ?? state.title),
      });
    }
  }
  return output;
}

export function extractOpenCodeUsage(value: unknown): LocalAgentTokenUsage | undefined {
  return findUsage(value, ["usage", "tokens"]);
}

export function extractPiObservations(value: unknown): LocalAgentObservation[] {
  return extractArray(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const type = stringValue(record, ["type", "event"]) ?? "";
    if (!/(tool|function)/i.test(type)) return [];
    return [activityFromRecord(record, type)];
  });
}

export function extractPiUsage(value: unknown): LocalAgentTokenUsage | undefined {
  return findUsage(value, ["usage", "tokens"]);
}

export function extractAcpObservations(value: unknown): LocalAgentObservation[] {
  const record = asRecord(value);
  if (!record) return [];
  const update = asRecord(record.update) ?? record;
  const sessionUpdate = stringValue(update, ["sessionUpdate", "session_update"]) ?? "";
  if (!/(tool|function)/i.test(sessionUpdate) && !hasAny(update, ["toolCallId", "tool_call_id", "toolName"])) {
    return [];
  }
  return [activityFromRecord(update, sessionUpdate || "tool")];
}

export function extractAcpUsage(value: unknown): LocalAgentTokenUsage | undefined {
  return findUsage(value, ["usage", "usage_update", "tokens"]);
}

function activityFromRecord(record: Record<string, unknown>, fallbackName: string): LocalAgentActivityObservation {
  const type = stringValue(record, ["type", "event", "sessionUpdate", "session_update"]) ?? fallbackName;
  return {
    kind: "activity",
    activityId: stringValue(record, ["id", "callId", "call_id", "toolCallId", "tool_call_id"]),
    toolName: stringValue(record, ["toolName", "tool_name", "tool", "name", "command"]) ?? fallbackName,
    toolStatus: mapToolStatus(stringValue(record, ["status", "state", "event"]) ?? type),
    message: stringValue(record, ["message", "title", "text"]),
    detail: stringifyDetail(record.output ?? record.result ?? record.error),
  };
}

function mapToolStatus(value: string): LocalAgentToolStatus {
  const normalized = value.toLowerCase();
  if (/(fail|error|abort|cancel)/.test(normalized)) return "failed";
  if (/(complete|done|success|finish|result)/.test(normalized)) return "completed";
  if (/(start|begin|call|pending)/.test(normalized)) return "started";
  return "updated";
}

function findUsage(value: unknown, keys: string[]): LocalAgentTokenUsage | undefined {
  const candidates = [value, ...extractArray(value)];
  for (const record of candidates.reverse()) {
    for (const key of keys) {
      const usage = normalizeUsage(asRecord(record)?.[key]);
      if (usage) return usage;
    }
    for (const nestedKey of ["info", "message", "data", "result"]) {
      const nested = asRecord(asRecord(record)?.[nestedKey]);
      if (!nested) continue;
      for (const key of keys) {
        const usage = normalizeUsage(nested[key]);
        if (usage) return usage;
      }
      const usage = normalizeUsage(nested);
      if (usage) return usage;
    }
    const usage = normalizeUsage(record);
    if (usage) return usage;
  }
  return undefined;
}

function normalizeUsage(value: unknown): LocalAgentTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: LocalAgentTokenUsage = {};
  const input = numberValue(record, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = numberValue(record, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const total = numberValue(record, ["total", "totalTokens", "total_tokens"]);
  const cache = asRecord(record.cache);
  const cacheRead = numberValue(record, ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]) ?? numberValue(cache, ["read", "readTokens", "read_tokens"]);
  const cacheWrite = numberValue(record, ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]) ?? numberValue(cache, ["write", "writeTokens", "write_tokens"]);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function addUsage(target: LocalAgentTokenUsage, next: LocalAgentTokenUsage): void {
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const value = next[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "messages", "events", "updates", "data", "result"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [value];
}

function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  return record?.data ?? record?.result ?? value;
}

function arrayValue(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  return record && Array.isArray(record[key]) ? record[key] as unknown[] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasAny(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => record[key] !== undefined);
}

function stringValue(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}

function numberValue(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return undefined;
}

function stringifyDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
