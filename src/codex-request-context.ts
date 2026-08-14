import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { CodexMcpElicitationHandler } from "./codex-mcp-client.js";

const execFile = promisify(execFileCallback);
const MAX_METADATA_IDENTIFIER_LENGTH = 512;

export class CodexRequestContextError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexRequestContextError";
  }
}

export interface CodexTurnMetadata extends Record<string, unknown> {
  session_id: string;
  turn_id: string;
}

export interface CodexExecutionContext {
  requestMeta?: Record<string, unknown>;
  mcpSessionId?: string;
  requestId?: string | number;
  onElicitation?: CodexMcpElicitationHandler;
}

export function extractAuthenticCodexTurnMetadata(
  requestMeta: Record<string, unknown> | undefined,
): CodexTurnMetadata | undefined {
  const candidate = requestMeta?.["x-codex-turn-metadata"];
  if (!isRecord(candidate)) return undefined;
  const sessionId = validIdentifier(candidate.session_id);
  const turnId = validIdentifier(candidate.turn_id);
  if (!sessionId || !turnId) return undefined;
  return {
    ...candidate,
    session_id: sessionId,
    turn_id: turnId,
  };
}

export function createLocalCodexTurnMetadata(
  context: CodexExecutionContext,
): CodexTurnMetadata {
  const openAiSession = context.requestMeta?.["openai/session"];
  const sessionSeed = typeof openAiSession === "string" && openAiSession
    ? openAiSession
    : context.mcpSessionId ?? randomUUID();
  const turnSeed = context.requestId === undefined
    ? randomUUID()
    : String(context.requestId);
  return {
    session_id: `devspace_${digestIdentifier(sessionSeed)}`,
    turn_id: `request_${digestIdentifier(`${sessionSeed}:${turnSeed}:${randomUUID()}`)}`,
    thread_source: "devspace",
  };
}

export async function codexTurnMetadataForComputerUse(
  context: CodexExecutionContext,
  options: { screenLocked?: boolean } = {},
): Promise<CodexTurnMetadata> {
  const authentic = extractAuthenticCodexTurnMetadata(context.requestMeta);
  if (authentic) return authentic;

  const screenLocked = options.screenLocked ?? await isMacScreenLocked();
  if (screenLocked) {
    throw new CodexRequestContextError(
      "The Mac is locked, but the current ChatGPT MCP request does not include authentic Codex thread and turn metadata. Unlock the Mac before using native Computer Use. Chrome Use remains available while locked.",
      "codex_computer_use_locked_context_unavailable",
    );
  }
  return createLocalCodexTurnMetadata(context);
}

export function codexTurnMetadataForChromeUse(
  context: CodexExecutionContext,
): CodexTurnMetadata {
  return extractAuthenticCodexTurnMetadata(context.requestMeta)
    ?? createLocalCodexTurnMetadata(context);
}

export function codexConversationKey(
  context: CodexExecutionContext,
): string | undefined {
  const authentic = extractAuthenticCodexTurnMetadata(context.requestMeta);
  if (authentic) return `codex:${authentic.session_id}`;
  const openAiSession = context.requestMeta?.["openai/session"];
  if (typeof openAiSession === "string" && openAiSession.trim()) {
    return `openai:${digestIdentifier(openAiSession.trim())}`;
  }
  if (context.mcpSessionId?.trim()) {
    return `mcp:${digestIdentifier(context.mcpSessionId.trim())}`;
  }
  return undefined;
}

export async function isMacScreenLocked(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const result = await execFile("/usr/sbin/ioreg", ["-l", "-w0"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return /"CGSSessionScreenIsLocked"\s*=\s*(?:Yes|true|1)/u.test(result.stdout);
  } catch (error) {
    throw new CodexRequestContextError(
      "Unable to determine whether the macOS screen is locked.",
      "codex_screen_lock_state_unavailable",
      { cause: error },
    );
  }
}

function validIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_METADATA_IDENTIFIER_LENGTH) return undefined;
  return normalized;
}

function digestIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
