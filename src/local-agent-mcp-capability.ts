import { createHmac, timingSafeEqual } from "node:crypto";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

const CAPABILITY_VERSION = 1;

export interface LocalAgentMcpCapability {
  version: typeof CAPABILITY_VERSION;
  parentAgentId: string;
  workspaceId: string;
  workspaceRoot: string;
  maxWriteMode: LocalAgentWriteMode;
}

export function createLocalAgentMcpCapability(
  secret: string,
  input: Omit<LocalAgentMcpCapability, "version">,
): string {
  const payload = Buffer.from(JSON.stringify({ version: CAPABILITY_VERSION, ...input }), "utf8").toString("base64url");
  return `${payload}.${signCapability(secret, payload)}`;
}

export function verifyLocalAgentMcpCapability(
  secret: string,
  token: string,
): LocalAgentMcpCapability {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) throw invalidCapability();
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = signCapability(secret, payload);
  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    receivedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) throw invalidCapability();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalidCapability();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalidCapability();
  const record = decoded as Record<string, unknown>;
  const maxWriteMode = record.maxWriteMode;
  if (
    record.version !== CAPABILITY_VERSION
    || typeof record.parentAgentId !== "string"
    || typeof record.workspaceId !== "string"
    || typeof record.workspaceRoot !== "string"
    || (maxWriteMode !== "read_only" && maxWriteMode !== "allowed" && maxWriteMode !== "full_access")
  ) throw invalidCapability();
  return {
    version: CAPABILITY_VERSION,
    parentAgentId: record.parentAgentId,
    workspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    maxWriteMode,
  };
}

function signCapability(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function invalidCapability(): Error {
  return new Error("Invalid DevSpace agent MCP capability.");
}
