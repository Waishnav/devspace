import { AgentProviderProtocolError } from "./local-agent-errors.js";
import { z } from "zod";

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

type GrokJsonValue = string | number | boolean | null | GrokJsonValue[] | GrokRecord;

type GrokRecord = { readonly [key: string]: GrokJsonValue };

type GrokProtocolInputValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly GrokProtocolInputValue[]
  | GrokProtocolInput;

export interface GrokProtocolInput {
  readonly [key: string]: GrokProtocolInputValue;
}

const grokJsonValueSchema: z.ZodType<GrokJsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(grokJsonValueSchema), z.record(z.string(), grokJsonValueSchema)]),
);

const grokProtocolPayloadSchema = z.record(z.string(), grokJsonValueSchema);

type GrokRejection = Error;

interface PendingPromptCompletion {
  sessionId: string;
  promptId: string;
  resolve: (completion: GrokPromptCompletion) => void;
  reject: (error: GrokRejection) => void;
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

  rejectAll(error: GrokRejection): void {
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

export function parseGrokPromptCompletion(input: GrokProtocolInput): GrokPromptCompletion | undefined {
  const record = parseGrokProtocolPayload(input);

  if (!record) return undefined;

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

  const completion: GrokPromptCompletion = {
    sessionId,
  };

  if (promptId) completion.promptId = promptId;

  const stopReason = firstString(record.stopReason, update?.stopReason);

  if (stopReason) completion.stopReason = stopReason;

  return completion;
}

export function readGrokSessionState(value: GrokProtocolInput | null): GrokSessionState | undefined {
  const record = parseGrokProtocolPayload(value);

  if (!record) return undefined;

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
    provider: "grok",
    operation: "configure_session",
    retryable: false,
    message,
  });
}

export function isGrokReasoningEffort(value: string): value is GrokReasoningEffort {
  return GROK_REASONING_EFFORTS.some((effort) => effort === value);
}

function readGrokModelInfo(value: GrokJsonValue): GrokModelInfo | undefined {
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

function firstString(...values: (GrokJsonValue | undefined)[]): string | undefined {
  for (const value of values) {
    const result = directString(value);

    if (result) return result;
  }

  return undefined;
}

function readArray(value: GrokJsonValue | undefined): GrokJsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function directString(value: GrokJsonValue | undefined): string | undefined {
  const result = z.string().safeParse(value);

  return result.success && result.data.trim() ? result.data.trim() : undefined;
}

function asRecord(value: GrokJsonValue | undefined): GrokRecord | undefined {
  return isGrokRecord(value) ? value : undefined;
}

function isGrokRecord(value: GrokJsonValue | undefined): value is GrokRecord {
  return grokProtocolPayloadSchema.safeParse(value).success;
}

function parseGrokProtocolPayload(input: GrokProtocolInput | null): GrokRecord | undefined {
  const parsed = grokProtocolPayloadSchema.safeParse(input);

  return parsed.success ? parsed.data : undefined;
}
