import { createHmac, timingSafeEqual } from "node:crypto";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CLIENT_ID_PREFIX = "devspace-v1";
const MAX_CLIENT_ID_LENGTH = 4096;

type ClientRegistrationPayload = Omit<OAuthClientInformationFull, "client_id">;

export type RecoverableClientIdResult =
  | {
      kind: "recoverable";
      clientId: string;
      registration: ClientRegistrationPayload;
    }
  | { kind: "unsupported" }
  | { kind: "too_large"; length: number; maxLength: number };

export function createRecoverableClientId(
  client: ClientRegistrationPayload,
  signingKey: string,
): RecoverableClientIdResult {
  const parsed = OAuthClientInformationFullSchema.safeParse({
    ...client,
    client_id: "pending",
  });
  if (!parsed.success || !isPublicClient(parsed.data)) {
    return { kind: "unsupported" };
  }

  const { client_id: _clientId, ...validatedRegistration } = parsed.data;
  const payload = Buffer.from(JSON.stringify(validatedRegistration)).toString("base64url");
  const signedValue = `${CLIENT_ID_PREFIX}.${payload}`;
  const signature = sign(signedValue, signingKey);
  const clientId = `${signedValue}.${signature}`;
  if (clientId.length > MAX_CLIENT_ID_LENGTH) {
    return {
      kind: "too_large",
      length: clientId.length,
      maxLength: MAX_CLIENT_ID_LENGTH,
    };
  }

  return {
    kind: "recoverable",
    clientId,
    registration: validatedRegistration,
  };
}

export function recoverClientRegistration(
  clientId: string,
  signingKey: string,
): OAuthClientInformationFull | undefined {
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return undefined;

  const [prefix, payload, signature, extra] = clientId.split(".");
  if (prefix !== CLIENT_ID_PREFIX || !payload || !signature || extra !== undefined) {
    return undefined;
  }

  const signedValue = `${prefix}.${payload}`;
  if (!safeEquals(signature, sign(signedValue, signingKey))) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }

  const parsed = OAuthClientInformationFullSchema.safeParse({
    ...(isRecord(decoded) ? decoded : {}),
    client_id: clientId,
  });
  if (!parsed.success || !isPublicClient(parsed.data)) return undefined;
  return parsed.data;
}

function isPublicClient(client: OAuthClientInformationFull): boolean {
  return (
    client.token_endpoint_auth_method === "none" &&
    client.client_secret === undefined &&
    client.client_secret_expires_at === undefined
  );
}

function sign(value: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(value).digest("base64url");
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
