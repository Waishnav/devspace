import type {
  LocalAgentActivity,
  LocalAgentRunCallbacks,
  LocalAgentUsageSnapshot,
} from "./local-agent-runtime.js";

export function observeCodexEvent(
  method: string,
  params: unknown,
  callbacks?: LocalAgentRunCallbacks,
): void {
  const record = asRecord(params);
  const item = asRecord(record?.item);
  if (item) {
    const status = method.includes("completed")
      ? item.status === "failed" ? "failed" : "completed"
      : "running";
    const activity = codexItemActivity(item, status);
    if (activity) callbacks?.onActivity?.(activity);
  }

  if (method !== "turn/completed") return;
  const turn = asRecord(record?.turn);
  const usage = tokenUsage(
    asRecord(record?.usage) ?? asRecord(turn?.usage),
    "final",
  );
  if (usage) callbacks?.onUsage?.(usage);
}

export function observeClaudeMessage(
  value: unknown,
  accumulated: LocalAgentUsageSnapshot | undefined,
  callbacks?: LocalAgentRunCallbacks,
): LocalAgentUsageSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return accumulated;
  notifyClaudeActivity(record, callbacks);

  const final = record.type === "result";
  const message = asRecord(record.message);
  const current = claudeUsage(final ? record.usage : message?.usage, final ? "final" : "partial");
  if (!current) return accumulated;

  const usage = final ? current : addUsage(accumulated, current);
  callbacks?.onUsage?.(usage);
  return usage;
}

export function observeOpenCodeResult(
  value: unknown,
  callbacks?: LocalAgentRunCallbacks,
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
      callbacks?.onActivity?.({
        kind: toolKind(directString(part.tool) ?? directString(part.name)),
        status: normalizeActivityStatus(state?.status ?? part.status),
        label: directString(part.tool) ?? directString(part.name) ?? "tool",
      });
    }
  }
  if (usage) callbacks?.onUsage?.(usage);
  return usage;
}

export function observePiEvent(
  event: unknown,
  callbacks?: LocalAgentRunCallbacks,
): LocalAgentUsageSnapshot | undefined {
  const record = asRecord(event);
  if (!record) return undefined;
  const usage = tokenUsage(
    asRecord(record.usage) ?? asRecord(asRecord(record.message)?.usage),
    record.type === "agent_end" ? "final" : "partial",
  );
  if (usage) callbacks?.onUsage?.(usage);

  const tool = asRecord(record.tool) ?? asRecord(record.toolCall) ?? asRecord(record.toolExecution);
  const name = directString(record.toolName) ?? directString(tool?.name);
  if (!name) return usage;
  const detail = directString(record.command) ?? directString(asRecord(tool?.arguments)?.command);
  callbacks?.onActivity?.({
    kind: toolKind(name),
    status: normalizeActivityStatus(
      record.status ?? tool?.status ?? (record.type === "tool_execution_end" ? "completed" : "running"),
    ),
    label: name,
    ...(detail ? { detail } : {}),
  });
  return usage;
}

export function observeAcpUpdate(
  value: unknown,
  callbacks?: LocalAgentRunCallbacks,
): void {
  const record = asRecord(value);
  const update = asRecord(record?.update) ?? record;
  if (!update) return;
  if (update.sessionUpdate === "usage_update") {
    const usage = tokenUsage(asRecord(update.usage), "partial");
    if (usage) callbacks?.onUsage?.(usage);
    return;
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
  const label = directString(update.title) ?? directString(update.kind) ?? "tool";
  callbacks?.onActivity?.({
    kind: acpToolKind(directString(update.kind)),
    status: normalizeActivityStatus(update.status),
    label,
  });
}

function notifyClaudeActivity(
  record: Record<string, unknown>,
  callbacks?: LocalAgentRunCallbacks,
): void {
  if (record.type === "tool_progress" && typeof record.tool_name === "string") {
    callbacks?.onActivity?.({ kind: "tool", status: "running", label: record.tool_name });
    return;
  }
  if (record.type === "tool_use_summary" && typeof record.summary === "string") {
    callbacks?.onActivity?.({ kind: "tool", status: "completed", label: record.summary });
    return;
  }
  if (record.type !== "assistant") return;
  const content = Array.isArray(asRecord(record.message)?.content)
    ? asRecord(record.message)?.content as unknown[]
    : [];
  for (const block of content) {
    const item = asRecord(block);
    if (item?.type !== "tool_use" || typeof item.name !== "string") continue;
    callbacks?.onActivity?.({
      kind: toolKind(item.name),
      status: "running",
      label: item.name,
      ...(claudeToolDetail(item.input) ? { detail: claudeToolDetail(item.input) } : {}),
    });
  }
}

function codexItemActivity(
  item: Record<string, unknown>,
  status: LocalAgentActivity["status"],
): LocalAgentActivity | undefined {
  const type = directString(item.type);
  if (type === "command_execution" || type === "commandExecution") {
    return { kind: "command", status, label: directString(item.command) ?? "command" };
  }
  if (type === "file_change" || type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => {
          const record = asRecord(change);
          return [directString(record?.kind), directString(record?.path)].filter(Boolean).join(" ");
        }).filter(Boolean).join(", ")
      : undefined;
    return {
      kind: "file",
      status,
      label: "apply file changes",
      ...(changes ? { detail: changes } : {}),
    };
  }
  if (type === "mcp_tool_call" || type === "mcpToolCall") {
    const server = directString(item.server);
    const tool = directString(item.tool);
    return { kind: "tool", status, label: [server, tool].filter(Boolean).join(".") || "MCP tool" };
  }
  if (type === "web_search" || type === "webSearch") {
    return {
      kind: "tool",
      status,
      label: "web search",
      ...(directString(item.query) ? { detail: directString(item.query) } : {}),
    };
  }
  return undefined;
}

function claudeUsage(value: unknown, state: "partial" | "final"): LocalAgentUsageSnapshot | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  if (
    inputTokens === undefined
    && cachedInputTokens === undefined
    && cacheCreationInputTokens === undefined
    && outputTokens === undefined
  ) return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens:
      (inputTokens ?? 0)
      + (cachedInputTokens ?? 0)
      + (cacheCreationInputTokens ?? 0)
      + (outputTokens ?? 0),
    state,
  };
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
    cachedInputTokens: nonNegativeInteger(
      value.cached_input_tokens ?? value.cachedInputTokens ?? cache?.read ?? value.cached_read_tokens,
    ),
    cacheCreationInputTokens: nonNegativeInteger(
      value.cache_creation_input_tokens ?? value.cacheCreationInputTokens ?? cache?.write,
    ),
    outputTokens,
    totalTokens: explicitTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    state,
  };
}

function addUsage(
  accumulated: LocalAgentUsageSnapshot | undefined,
  current: LocalAgentUsageSnapshot,
): LocalAgentUsageSnapshot {
  return {
    inputTokens: sumOptional(accumulated?.inputTokens, current.inputTokens),
    cachedInputTokens: sumOptional(accumulated?.cachedInputTokens, current.cachedInputTokens),
    cacheCreationInputTokens: sumOptional(
      accumulated?.cacheCreationInputTokens,
      current.cacheCreationInputTokens,
    ),
    outputTokens: sumOptional(accumulated?.outputTokens, current.outputTokens),
    totalTokens: (accumulated?.totalTokens ?? 0) + current.totalTokens,
    state: current.state,
  };
}

function openCodeMessages(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  const data = record?.data;
  const values = Array.isArray(data) ? data : data ? [data] : [];
  return values.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
}

function claudeToolDetail(input: unknown): string | undefined {
  const record = asRecord(input);
  for (const key of ["command", "file_path", "path", "query"]) {
    if (typeof record?.[key] === "string") return record[key];
  }
  return undefined;
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

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
