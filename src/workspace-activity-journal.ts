import { isJsonString, isObjectValue, isJsonNumber, optionalFields, jsonKind } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import type { JsonObject, WireInput } from "./json-value.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import type {
  WorkspaceActivityStore,
  WorkspaceToolCallOrigin,
  WorkspaceTurn,
} from "./workspace-activity-store.js";

type ToolHandlerExtra = {
  _meta?: JsonObject;
  requestId?: WireInput;
};

interface SerializedError {
  name: string;
  message: string;
}

const MAX_STRING_LENGTH = 8 * 1024;
const MAX_RECORD_LENGTH = 64 * 1024;
const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i;

// Value patterns are deliberately shape- or context-bound (an Authorization
// header, an env-var name, a credential flag) so ordinary prose and source code
// such as "Basic functionality" or `MAX_TOKENS=4096` survive intact. A pattern's
// replacement may keep its leading context via $1.
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic|Token|Digest)\s+[^\s"']+/gi, `$1${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, `Bearer ${REDACTED}`],
  // ALL_CAPS env assignment whose name ends in a secret word: API_KEY=…, export GITHUB_TOKEN="…".
  // MAX_TOKENS=… and values that defer to another variable ($VAR, $(cmd)) are left alone.
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|CREDENTIALS?)=)(?!\$)(?:"[^"]*"|'[^']*'|[^\s"'`;&|)]+)/g, `$1${REDACTED}`],
  // CLI credential flags: --password hunter2, --api-key=abc. --password-stdin takes no value.
  [/(--(?:[a-z0-9]+-)*(?:password|passwd|token|secret|api-?key|access-?key|secret-?key|private-?key)(?:\s+|=))(?![-$])(?:"[^"]*"|'[^']*'|[^\s"'`;&|)]+)/gi, `$1${REDACTED}`],
  // Credentials embedded in a URL: https://user:pass@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/?#]+:[^\s@/?#]+@/gi, `$1${REDACTED}@`],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
];

/**
 * Records every registered MCP tool call into the open turn of its workspace.
 *
 * A turn is the work between two review checkpoints: a model-initiated
 * show_changes closes the open turn with its review_ref, and the next call
 * starts a new one. Calls are persisted only once their workspace exists, so a
 * failed open_workspace leaves nothing behind. Journal failures are reported to
 * `onError` and never change the tool outcome.
 */
export class WorkspaceActivityJournal {
  constructor(
    private readonly store: WorkspaceActivityStore,
    private readonly onError: (error: WireInput) => void = () => {},
  ) {}

  async capture<T>(input: {
    toolName: string;
    arguments: WireInput;
    extra: ToolHandlerExtra;
    operation: () => Promise<T>;
  }): Promise<T> {
    const startedAt = new Date();
    const startedAtMs = performance.now();
    const argumentWorkspaceId = workspaceIdFromValue(input.arguments);

    // Calls belong to the turn that was open when they started.
    const turnId = argumentWorkspaceId
      ? this.safely(() => this.openTurnId(argumentWorkspaceId, startedAt))
      : undefined;

    let result: T;

    try {
      result = await input.operation();
    } catch (error) {
      this.safely(() => this.record(input, {
        workspaceId: argumentWorkspaceId,
        turnId,
        startedAt,
        startedAtMs,
        error: serializeError(error),
      }));
      throw error;
    }

    this.safely(() => this.record(input, {
      workspaceId: workspaceIdFromValue(result) ?? argumentWorkspaceId,
      turnId,
      startedAt,
      startedAtMs,
      result,
    }));

    return result;
  }

  /**
   * Hook point for subagent activity: the turn that events for `workspaceId`
   * should attach to right now. Subagent events (#379–384) are not journaled
   * yet; their app-owned turnId is a subagent turn, not this workspace turn.
   */
  currentTurn(workspaceId: string): WorkspaceTurn | undefined {
    return this.safely(() => this.store.currentTurn(workspaceId));
  }

  private openTurnId(workspaceId: string, now: Date): number | undefined {
    return this.store.hasWorkspace(workspaceId)
      ? this.store.openTurn(workspaceId, now).id
      : undefined;
  }

  private record(
    input: { toolName: string; arguments: WireInput; extra: ToolHandlerExtra },
    outcome: {
      workspaceId?: string;
      turnId?: number;
      startedAt: Date;
      startedAtMs: number;
      result?: WireInput;
      error?: { name: string; message: string };
    },
  ): void {
    if (!outcome.workspaceId || !this.store.hasWorkspace(outcome.workspaceId)) return;

    const completedAt = new Date();
    const origin = toolCallOrigin(input.extra._meta);

    const reviewRef = origin === "model" && input.toolName === "show_changes" && !outcome.error
      ? reviewRefFromValue(outcome.result)
      : undefined;

    const turnId = reviewRef
      ? this.store.closeTurn(outcome.workspaceId, reviewRef, completedAt).id
      : outcome.turnId ?? this.store.openTurn(outcome.workspaceId, completedAt).id;

    const resultSummary = outcome.result === undefined ? undefined : summarizeResult(outcome.result);

    this.store.recordToolCall({
      turnId,
      origin,
      conversationScopeId: conversationScopeIdFromRequestMeta(input.extra._meta),
      requestId: requestIdFromExtra(input.extra.requestId),
      toolName: input.toolName,
      argumentsJson: journalJson(input.arguments ?? {}),
      ...optionalFields(resultSummary === undefined ? undefined : { resultJson: journalJson(resultSummary) }),
      ...optionalFields(outcome.error ? { errorJson: journalJson(outcome.error) } : undefined),
      isError: outcome.error !== undefined || asRecord(outcome.result)?.isError === true,
      startedAt: outcome.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.round(performance.now() - outcome.startedAtMs),
    });
  }

  private safely<R>(operation: () => R): R | undefined {
    try {
      return operation();
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        // Error reporting must not affect the tool call either.
      }

      return undefined;
    }
  }
}

/** Serializes a value for the journal with secrets redacted and size capped. */
export function journalJson(value: WireInput): string {
  const json = JSON.stringify(redact(value, 0)) ?? "null";

  if (json.length <= MAX_RECORD_LENGTH) return json;

  return JSON.stringify({
    truncated: true,
    length: json.length,
    preview: json.slice(0, MAX_STRING_LENGTH),
  });
}

/**
 * Keeps what a reader needs to understand a tool result: its text, structured
 * content, and error flag. Card metadata (`_meta`) is dropped because it
 * duplicates large payloads such as full review patches.
 */
function summarizeResult(result: WireInput): WireInput {
  const record = asRecord(result);

  if (!record || !Array.isArray(record.content)) return result;

  const text = record.content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && isJsonString(block.text))
    .map((block) => unsafeNarrow<string>(block!.text))
    .join("\n");

  return {
    ...optionalFields(text ? { text } : undefined),
    ...optionalFields(record.structuredContent !== undefined ? { structuredContent: record.structuredContent } : undefined),
    ...optionalFields(record.isError === true ? { isError: true } : undefined),
  };
}

function redact(value: WireInput, depth: number): WireInput {
  if (isJsonString(value)) return redactString(value);

  if (value === null || !isObjectValue(value)) return value;

  if (depth > 8) return "[nested]";

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(
    // SAFETY: The surrounding checks or construction already match this type.
    Object.entries(value as JsonObject).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) && isJsonString(item) && item !== ""
        ? REDACTED
        : redact(item, depth + 1),
    ]),
  );
}

function redactString(value: string): string {
  let redacted = value;

  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}… [truncated ${redacted.length - MAX_STRING_LENGTH} chars]`
    : redacted;
}

/** The workspace card replays historical reviews through show_changes with this marker. */
function toolCallOrigin(meta: JsonObject | undefined): WorkspaceToolCallOrigin {
  return isJsonString(meta?.["devspace/reviewRef"]) ? "card" : "model";
}

function workspaceIdFromValue(value: WireInput): string | undefined {
  const record = asRecord(value);
  const direct = record?.workspace_id;

  if (isJsonString(direct) && direct.length > 0) return direct;

  const structured = asRecord(record?.structuredContent);
  const nested = structured?.workspace_id;

  return isJsonString(nested) && nested.length > 0 ? nested : undefined;
}

function reviewRefFromValue(value: WireInput): string | undefined {
  const structured = asRecord(asRecord(value)?.structuredContent);
  const reviewRef = structured?.review_ref;

  return isJsonString(reviewRef) && reviewRef.length > 0 ? reviewRef : undefined;
}

function requestIdFromExtra(value: WireInput): string | undefined {
  return isJsonString(value) || isJsonNumber(value) ? String(value) : undefined;
}

function serializeError(error: WireInput): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: jsonKind(error), message: String(error) };
}

function asRecord(value: WireInput): JsonObject | undefined {
  return value !== null && isObjectValue(value) && !Array.isArray(value)
    // SAFETY: The surrounding checks or construction already match this type.
    ? unsafeNarrow<JsonObject>(value)
    : undefined;
}
