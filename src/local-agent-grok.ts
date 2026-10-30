import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonString, isObjectValue, optionalFields } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import type { WireInput, JsonObject } from "./json-value.js";
import { AgentProviderProtocolError } from "./local-agent-errors.js";

export const GROK_DEFAULT_MODEL = "grok-build";

export const GROK_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORTS)[number];

const COMPLETED_PROMPT_ID_LIMIT = 128;

export interface GrokModelInfo {
  id: string;
  reasoningEfforts: readonly string[];
}

export interface GrokSessionState {
  currentModelId?: string;
  availableModels: readonly GrokModelInfo[];
}

export interface GrokPromptCompletion {
  sessionId: string;
  promptId?: string;
  stopReason?: string;
}

interface PendingPromptCompletion {
  sessionId: string;
  promptId: string;
  resolve: (completion: GrokPromptCompletion) => void;
  reject: (error: WireInput) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owns the one ordering-sensitive xAI completion bridge. Grok may resolve the
 * standard session/prompt request or emit its private completion notification;
 * whichever arrives first settles the turn, while duplicate and stale events
 * are bounded and ignored.
 */
export class GrokPromptCompletionRegistry {
  private readonly pending = new Map<string, PendingPromptCompletion>();
  private readonly completedPromptIds: string[] = [];

  wait(
    sessionId: string,
    promptId: string,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<GrokPromptCompletion> {
    const key = promptKey(sessionId, promptId);

    if (this.pending.has(key)) {
      throw new Error(`Grok prompt completion is already pending: ${promptId}`);
    }

    return new Promise<GrokPromptCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(onTimeout());
      }, timeoutMs);

      timer.unref();
      this.pending.set(key, { sessionId, promptId, resolve, reject, timer });
    });
  }

  resolve(completion: GrokPromptCompletion): void {
    if (completion.promptId && this.completedPromptIds.includes(completion.promptId)) return;

    const pending = completion.promptId
      ? this.pending.get(promptKey(completion.sessionId, completion.promptId))
      : findPendingForSession(this.pending, completion.sessionId);

    if (!pending) return;
    this.pending.delete(promptKey(pending.sessionId, pending.promptId));
    clearTimeout(pending.timer);
    this.rememberCompletedPromptId(completion.promptId ?? pending.promptId);
    pending.resolve({ ...completion, promptId: completion.promptId ?? pending.promptId });
  }

  remove(sessionId: string, promptId: string): void {
    const key = promptKey(sessionId, promptId);
    const pending = this.pending.get(key);

    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
  }

  rejectAll(error: WireInput): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();

    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  markCompleted(sessionId: string, promptId: string): void {
    const key = promptKey(sessionId, promptId);
    const pending = this.pending.get(key);

    if (pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
    }

    this.rememberCompletedPromptId(promptId);
  }

  get size(): number {
    return this.pending.size;
  }

  private rememberCompletedPromptId(promptId: string): void {
    if (this.completedPromptIds.includes(promptId)) return;
    this.completedPromptIds.push(promptId);

    if (this.completedPromptIds.length > COMPLETED_PROMPT_ID_LIMIT) {
      this.completedPromptIds.splice(0, this.completedPromptIds.length - COMPLETED_PROMPT_ID_LIMIT);
    }
  }
}

export function parseGrokPromptCompletion(input: WireInput): GrokPromptCompletion | undefined {
  const record = asRecord(input);
  const sessionId = directString(record?.sessionId);

  if (!sessionId) return undefined;

  const update = asRecord(record?.update);
  const sessionUpdate = directString(update?.sessionUpdate);

  if (update && sessionUpdate !== "turn_completed") return undefined;

  const promptId = firstString(
    record?.promptId,
    record?.requestId,
    update?.promptId,
    update?.requestId,
    asRecord(record?._meta)?.promptId,
    asRecord(update?._meta)?.promptId,
  );

  if (promptId && isBackgroundPromptId(promptId)) return undefined;

  return {
    sessionId,
    ...optionalFields(promptId ? { promptId } : undefined),
    ...optionalFields((firstString(record?.stopReason, update?.stopReason)) ? { stopReason: firstString(record?.stopReason, update?.stopReason) } : undefined),
  };
}

export function readGrokSessionState(value: WireInput): GrokSessionState | undefined {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;

  const models = asRecord(response?.models)
    ?? asRecord(asRecord(response?._meta)?.modelState);

  if (!models) return undefined;

  const availableModels = (readArray(models.availableModels) ?? [])
    .map(readGrokModelInfo)
    .filter((model): model is GrokModelInfo => model !== undefined);

  return {
    currentModelId: directString(models.currentModelId),
    availableModels,
  };
}

export function normalizeGrokModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) return undefined;

  return trimmed.replace(/^(?:grok|xai)\//i, "");
}

export function resolveGrokModelId(
  requested: string,
  state: GrokSessionState | undefined,
): string {
  const modelId = normalizeGrokModelId(requested);

  if (!modelId) throw grokConfigurationError("Grok model must not be empty.");
  const available = state?.availableModels ?? [];

  if (available.length > 0 && !available.some((model) => model.id === modelId)) {
    throw grokConfigurationError(
      `Grok does not support '${modelId}'. Available models: ${available.map((model) => model.id).join(", ")}.`,
    );
  }

  return modelId;
}

export function resolveGrokEffort(
  effort: string,
  state: GrokSessionState | undefined,
  modelId: string | undefined,
): GrokReasoningEffort {
  const normalized = effort.trim().toLowerCase();

  if (!isGrokReasoningEffort(normalized)) {
    throw grokConfigurationError(
      `Grok reasoning effort must be one of: ${GROK_REASONING_EFFORTS.join(", ")}.`,
    );
  }

  const selectedModel = state?.availableModels.find((model) => model.id === modelId);
  const availableEfforts = selectedModel?.reasoningEfforts ?? [];

  if (availableEfforts.length > 0 && !availableEfforts.includes(normalized)) {
    throw grokConfigurationError(
      `Grok model '${modelId ?? GROK_DEFAULT_MODEL}' does not support effort '${normalized}'. Available efforts: ${availableEfforts.join(", ")}.`,
    );
  }

  return normalized;
}

function grokConfigurationError(message: string): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "acp",
    operation: "configure_session",
    retryable: false,
    message,
  });
}

export function isGrokReasoningEffort(value: string): value is GrokReasoningEffort {
  // SAFETY: The surrounding checks or construction already match this type.
  return (GROK_REASONING_EFFORTS as readonly string[]).includes(value);
}

function readGrokModelInfo(value: WireInput): GrokModelInfo | undefined {
  const record = asRecord(value);
  const id = directString(record?.modelId) ?? directString(record?.id);

  if (!id) return undefined;
  const modelMeta = asRecord(record?._meta);

  const reasoningEfforts = (readArray(modelMeta?.reasoningEfforts) ?? [])
    .flatMap((entry) => {
      const effort = asRecord(entry);

      return [directString(effort?.id), directString(effort?.value)].filter(
        (value): value is string => value !== undefined,
      );
    })
    .filter((effort, index, values) => values.indexOf(effort) === index);

  return { id, reasoningEfforts };
}

function findPendingForSession(
  pending: ReadonlyMap<string, PendingPromptCompletion>,
  sessionId: string,
): PendingPromptCompletion | undefined {
  return Array.from(pending.values()).find((entry) => entry.sessionId === sessionId);
}

function promptKey(sessionId: string, promptId: string): string {
  return `${sessionId}\u0000${promptId}`;
}

function isBackgroundPromptId(promptId: string): boolean {
  return /^(?:task|subagent|background)(?:-|_)/i.test(promptId)
    || /^task-completed-/i.test(promptId);
}

function firstString(...values: WireInput[]): string | undefined {
  for (const value of values) {
    const result = directString(value);

    if (result) return result;
  }

  return undefined;
}

function readArray(value: WireInput): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function directString(value: WireInput): string | undefined {
  return isJsonString(value) && value.trim() ? value.trim() : undefined;
}

function asRecord(value: WireInput): JsonObject | undefined {
  return value !== null && isObjectValue(value) && !Array.isArray(value)
    // SAFETY: The surrounding checks or construction already match this type.
    ? unsafeNarrow<JsonObject>(value)
    : undefined;
}

const GROK_LOG_TAIL_BYTES = 512 * 1024;

/**
 * Grok reports a failed turn over ACP only as `stopReason: "error"` and writes the cause (such as a 401 for an
 * expired login) to its own log, so read that session's terminal failure from the end of the log. Best effort.
 */
export function readGrokTurnFailure(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = join(env.HOME ?? homedir(), ".grok", "logs", "unified.jsonl");
  let text: string;

  try {
    const size = statSync(path).size;
    const length = Math.min(size, GROK_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");

    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }

    text = buffer.toString("utf8");
  } catch {
    return undefined;
  }

  for (const line of text.split("\n").reverse()) {
    if (!line.includes(sessionId) || !line.includes("turn.terminal_failure")) continue;

    try {
      const entry = asRecord(JSON.parse(line));
      const message = directString(asRecord(entry?.ctx)?.message);

      if (entry?.sid === sessionId && message) return message.split("\n")[0];
    } catch {
      continue;
    }
  }

  return undefined;
}
