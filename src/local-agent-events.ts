import { randomUUID } from "node:crypto";

/**
 * DevSpace's normalized view of what a subagent turn is doing. Drivers map
 * provider-native frames into activity events; the manager owns the turn
 * lifecycle events and stamps every event with the app-owned turn id.
 */
export type LocalAgentToolStatus = "completed" | "failed";
export type LocalAgentTurnOutcome = "completed" | "failed" | "stopped";

export type LocalAgentActivityEvent =
  | { type: "message"; text: string }
  | { type: "tool_started"; tool: string; summary?: string }
  | { type: "tool_completed"; tool: string; summary?: string; status: LocalAgentToolStatus };

export type LocalAgentTurnEventBody =
  | { type: "turn_started" }
  | LocalAgentActivityEvent
  | { type: "turn_completed"; status: LocalAgentTurnOutcome; errorCode?: string; droppedEvents?: number };

export type LocalAgentTurnEvent = LocalAgentTurnEventBody & {
  turnId: string;
  seq: number;
  at: string;
};

export type LocalAgentTurnEventType = LocalAgentTurnEvent["type"];

export const LOCAL_AGENT_TURN_EVENT_TYPES = [
  "turn_started",
  "message",
  "tool_started",
  "tool_completed",
  "turn_completed",
] as const satisfies readonly LocalAgentTurnEventType[];

// Bounds keep one turn's log small enough to store and print, whatever the provider emits.
export const MAX_TURN_EVENTS = 500;
export const MAX_TURN_EVENT_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_NAME_CHARS = 80;
const MAX_SUMMARY_CHARS = 200;
const MAX_ERROR_DETAIL_CHARS = 1_000;

export function createLocalAgentTurnId(): string {
  return `trn_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** Applies redaction and size bounds to driver output before it leaves the adapter layer. */
export function sanitizeActivityEvent(event: LocalAgentActivityEvent): LocalAgentActivityEvent | undefined {
  if (event.type === "message") {
    const text = boundText(redactSecrets(event.text.trim()), MAX_MESSAGE_CHARS);
    return text ? { type: "message", text } : undefined;
  }
  const tool = boundText(redactSecrets(event.tool.trim()), MAX_TOOL_NAME_CHARS) || "tool";
  const summary = event.summary === undefined
    ? undefined
    : boundText(redactSecrets(singleLine(event.summary)), MAX_SUMMARY_CHARS) || undefined;
  return event.type === "tool_started"
    ? { type: "tool_started", tool, ...(summary ? { summary } : {}) }
    : { type: "tool_completed", tool, ...(summary ? { summary } : {}), status: event.status };
}

/**
 * Picks the most identifying argument of a tool call (a command, path, or
 * query) instead of persisting the full argument object.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length > 0) {
      return value.join(" ");
    }
  }
  return undefined;
}

/** The provider's own explanation of a failure, which the generic error message omits. */
export function providerErrorDetail(error: { message: string; cause?: unknown }): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error.cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = typeof current === "string"
      ? current
      : current instanceof Error || typeof (current as { message?: unknown }).message === "string"
        ? String((current as { message: unknown }).message)
        : undefined;
    if (message?.trim() && message.trim() !== error.message) {
      return boundText(redactSecrets(message.trim()), MAX_ERROR_DETAIL_CHARS);
    }
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-(?:[A-Za-z0-9_-]{2,}-)*[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|authorization|credential)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^\s"',;]{4,})/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
// `https://user:pass@host`: keep the user, drop the password.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*):[^\s/@]+@/gi;
// `--password hunter2`: a secret-named flag followed by its value as the next word.
// Plural "tokens" (e.g. --max-tokens 4096) is a count, not a credential.
const SECRET_FLAG = /(--?[A-Za-z0-9_-]*(?:api[_-]?key|token(?!s)|secret|password|passwd|authorization|credential)[A-Za-z0-9_-]*\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi;

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  redacted = redacted.replace(BEARER, "Bearer [redacted]");
  redacted = redacted.replace(URL_PASSWORD, "$1:[redacted]@");
  redacted = redacted.replace(SECRET_FLAG, "$1[redacted]");
  return redacted.replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[redacted]`);
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
