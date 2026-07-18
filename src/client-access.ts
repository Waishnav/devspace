export type ClientAccessMode = "off" | "enforce";

export interface ClientAccessConfig {
  mode: ClientAccessMode;
  deniedClients: string[];
}

export interface DeclaredClient {
  name: string;
  title?: string;
  version?: string;
  identities: string[];
}

export interface ClientAccessDecision {
  allowed: boolean;
  reason: "disabled" | "allowed" | "denied_client";
  matchedClient?: string;
}

export type JsonRpcId = string | number | null;

export function extractDeclaredClient(body: unknown): DeclaredClient | undefined {
  if (!isRecord(body) || body.method !== "initialize") return undefined;
  const params = body.params;
  if (!isRecord(params)) return undefined;
  const clientInfo = params.clientInfo;
  if (!isRecord(clientInfo)) return undefined;

  const name = sanitizeText(clientInfo.name);
  if (!name) return undefined;
  const title = sanitizeText(clientInfo.title);
  const version = sanitizeText(clientInfo.version);
  const identities = clientIdentities(name, title);

  return {
    name,
    ...(title ? { title } : {}),
    ...(version ? { version } : {}),
    identities,
  };
}

export function extractJsonRpcId(body: unknown): JsonRpcId {
  if (!isRecord(body)) return null;
  const id = body.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function evaluateClientAccess(
  config: ClientAccessConfig,
  client: DeclaredClient | undefined,
): ClientAccessDecision {
  if (config.mode === "off") {
    return { allowed: true, reason: "disabled" };
  }

  const identities = new Set(client?.identities ?? []);
  const deniedClient = normalizedPolicyEntries(config.deniedClients).find((entry) =>
    identities.has(entry),
  );
  if (deniedClient) {
    return {
      allowed: false,
      reason: "denied_client",
      matchedClient: deniedClient,
    };
  }

  return {
    allowed: true,
    reason: "allowed",
  };
}

function clientIdentities(name: string, title?: string): string[] {
  const identities = new Set<string>();
  const normalizedName = normalizeClientName(name);
  if (normalizedName) identities.add(normalizedName);

  const combined = `${name} ${title ?? ""}`.toLowerCase();
  if (/\bcodex\b/.test(combined) || normalizedName.includes("codex")) identities.add("codex");
  if (combined.includes("chatgpt") || normalizedName.includes("chatgpt")) identities.add("chatgpt");

  return [...identities];
}

function normalizedPolicyEntries(entries: string[]): string[] {
  return [...new Set(entries.map(normalizeClientName).filter(Boolean))];
}

function normalizeClientName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 160);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
