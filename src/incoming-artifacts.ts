import { basename, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ArtifactError } from "./artifacts.js";

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OPENAI_FILE_HOSTS = new Set([
  "files.oaiusercontent.com",
  "oaisdmntprcentralus.blob.core.windows.net",
  "oaisdmntprwestcentralus.blob.core.windows.net",
]);
const OPENAI_FILENAME_SAFE_FILE_ID_PATTERN = /^file[-_][A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const OPENAI_FILE_ID_MAX_LENGTH = 512;
const OPENAI_FILE_ID_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;
const OPENAI_FILE_KEYS = new Set([
  "download_url",
  "file_id",
  "mime_type",
  "file_name",
  "name",
  "size",
]);
const OPENAI_FILE_REDIRECT_LIMIT = 3;
const OPENAI_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface IncomingArtifactSource {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}

export interface IncomingArtifactAdapter {
  readonly id: string;
  canHandle(value: unknown): boolean;
  open(value: unknown): Promise<IncomingArtifactSource>;
}

export interface OpenedIncomingArtifact extends IncomingArtifactSource {
  adapterId: string;
}

export class IncomingArtifactAdapterRegistry {
  private readonly adapters: readonly IncomingArtifactAdapter[];

  constructor(adapters: readonly IncomingArtifactAdapter[] = []) {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      if (!ADAPTER_ID_PATTERN.test(adapter.id)) {
        throw new ArtifactError(
          "invalid_incoming_adapter",
          "Incoming artifact adapter IDs must be short lowercase identifiers.",
        );
      }
      if (ids.has(adapter.id)) {
        throw new ArtifactError(
          "duplicate_incoming_adapter",
          `Incoming artifact adapter '${adapter.id}' is registered more than once.`,
        );
      }
      ids.add(adapter.id);
    }
    this.adapters = [...adapters];
  }

  async open(value: unknown): Promise<OpenedIncomingArtifact> {
    const matching: IncomingArtifactAdapter[] = [];
    for (const adapter of this.adapters) {
      let handles = false;
      try {
        handles = adapter.canHandle(value);
      } catch {
        throw new ArtifactError(
          "incoming_artifact_adapter_failed",
          `Incoming artifact adapter '${adapter.id}' failed during recognition.`,
        );
      }
      if (handles) matching.push(adapter);
    }

    if (matching.length === 0) {
      throw new ArtifactError(
        "unsupported_incoming_artifact",
        "No trusted incoming artifact adapter recognized this file reference.",
      );
    }
    if (matching.length > 1) {
      throw new ArtifactError(
        "ambiguous_incoming_artifact",
        "More than one trusted incoming artifact adapter recognized this file reference.",
      );
    }

    const adapter = matching[0];
    let source: IncomingArtifactSource;
    try {
      source = await adapter.open(value);
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError(
        "incoming_artifact_open_failed",
        `Incoming artifact adapter '${adapter.id}' could not open the file reference.`,
      );
    }
    try {
      validateIncomingArtifactSource(source);
    } catch (error) {
      source?.stream?.destroy?.();
      throw error;
    }
    return { ...source, adapterId: adapter.id };
  }
}

export interface OpenAIFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
  size?: number;
}

export interface OpenAIIncomingArtifactAdapterOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenAIIncomingArtifactAdapter(
  options: OpenAIIncomingArtifactAdapterOptions = {},
): IncomingArtifactAdapter {
  const fetchFile = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_FILE_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ArtifactError(
      "invalid_openai_file_adapter",
      "OpenAI file download timeout must be a positive integer.",
    );
  }

  return {
    id: "openai-file",
    canHandle: isOpenAIFileReferenceCandidate,
    async open(value: unknown): Promise<IncomingArtifactSource> {
      const reference = normalizeOpenAIFileReference(value);

      let downloadUrl = validateOpenAIFileUrl(reference.download_url);
      let response: Response | undefined;
      for (let redirect = 0; redirect <= OPENAI_FILE_REDIRECT_LIMIT; redirect += 1) {
        try {
          response = await fetchFile(downloadUrl, {
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          throw new ArtifactError(
            "openai_file_download_failed",
            "ChatGPT file could not be downloaded.",
          );
        }

        if (!isRedirectStatus(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirect === OPENAI_FILE_REDIRECT_LIMIT) {
          throw new ArtifactError(
            "openai_file_download_failed",
            "ChatGPT file download returned an invalid redirect.",
          );
        }
        downloadUrl = validateOpenAIFileUrl(new URL(location, downloadUrl).toString());
      }

      if (!response?.ok || !response.body) {
        await response?.body?.cancel().catch(() => undefined);
        throw new ArtifactError(
          "openai_file_download_failed",
          "ChatGPT file download did not return file content.",
        );
      }

      const responseSize = responseContentLength(response);
      if (
        reference.size !== undefined
        && responseSize !== undefined
        && reference.size !== responseSize
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new ArtifactError(
          "openai_file_size_mismatch",
          "ChatGPT file metadata did not match the downloaded content.",
        );
      }
      const mimeType = reference.mime_type ?? responseMimeType(response);

      return {
        name: normalizeOpenAIFileName(reference.file_name, reference.file_id, mimeType),
        mimeType,
        size: responseSize ?? reference.size,
        stream: Readable.fromWeb(response.body as unknown as NodeReadableStream),
      };
    },
  };
}

export type IncomingArtifactValueShape =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean" }
  | { type: "number"; finite: boolean }
  | { type: "bigint" }
  | { type: "string"; kind: "absolute-path" | "url" | "data-url" | "text"; length: number }
  | { type: "array"; length: number; items: IncomingArtifactValueShape[]; truncated: boolean }
  | {
      type: "object";
      constructor?: string;
      entries: Record<string, IncomingArtifactValueShape>;
      truncated: boolean;
    }
  | { type: "function" | "symbol" }
  | { type: "cycle" };

export function describeIncomingArtifactValue(
  value: unknown,
  maxDepth = 4,
  maxEntries = 20,
): IncomingArtifactValueShape {
  const seen = new WeakSet<object>();

  const describe = (current: unknown, depth: number): IncomingArtifactValueShape => {
    if (current === null) return { type: "null" };
    if (current === undefined) return { type: "undefined" };
    if (typeof current === "boolean") return { type: "boolean" };
    if (typeof current === "number") return { type: "number", finite: Number.isFinite(current) };
    if (typeof current === "bigint") return { type: "bigint" };
    if (typeof current === "function") return { type: "function" };
    if (typeof current === "symbol") return { type: "symbol" };
    if (typeof current === "string") {
      return {
        type: "string",
        kind: classifyValueString(current),
        length: current.length,
      };
    }
    if (seen.has(current)) return { type: "cycle" };
    seen.add(current);

    if (Array.isArray(current)) {
      if (depth >= maxDepth) {
        return { type: "array", length: current.length, items: [], truncated: current.length > 0 };
      }
      const items = current.slice(0, maxEntries).map((item) => describe(item, depth + 1));
      return {
        type: "array",
        length: current.length,
        items,
        truncated: current.length > items.length,
      };
    }

    const keys = Object.keys(current).sort();
    if (depth >= maxDepth) {
      return {
        type: "object",
        constructor: safeConstructorName(current),
        entries: {},
        truncated: keys.length > 0,
      };
    }
    const entries: Record<string, IncomingArtifactValueShape> = {};
    for (const [index, key] of keys.slice(0, maxEntries).entries()) {
      let entryValue: unknown;
      try {
        entryValue = (current as Record<string, unknown>)[key];
      } catch {
        entryValue = undefined;
      }
      entries[safeValueEntryKey(key, index)] = describe(entryValue, depth + 1);
    }
    return {
      type: "object",
      constructor: safeConstructorName(current),
      entries,
      truncated: keys.length > Object.keys(entries).length,
    };
  };

  return describe(value, 0);
}

function validateIncomingArtifactSource(source: IncomingArtifactSource): void {
  if (!source || typeof source !== "object") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid source.",
    );
  }
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide a filename.",
    );
  }
  if (source.mimeType !== undefined && typeof source.mimeType !== "string") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid MIME hint.",
    );
  }
  if (
    source.size !== undefined
    && (!Number.isSafeInteger(source.size) || source.size < 0)
  ) {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid byte size.",
    );
  }
  const stream = source.stream as Partial<Readable> | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide an async-readable stream.",
    );
  }
}

function isOpenAIFileReferenceCandidate(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length >= 2
    && keys.every((key) => OPENAI_FILE_KEYS.has(key))
    && Object.hasOwn(value, "download_url")
    && Object.hasOwn(value, "file_id");
}

function normalizeOpenAIFileReference(value: unknown): OpenAIFileReference {
  if (!isOpenAIFileReferenceCandidate(value)) {
    throw new ArtifactError(
      "invalid_openai_file_reference",
      "ChatGPT file reference is malformed.",
    );
  }

  const downloadUrl = value.download_url;
  const fileId = value.file_id;
  if (
    typeof downloadUrl !== "string"
    || typeof fileId !== "string"
    || !isValidOpenAIFileId(fileId)
  ) {
    throw new ArtifactError(
      "invalid_openai_file_reference",
      "ChatGPT file reference is malformed.",
    );
  }

  const mimeType = nullableString(value.mime_type);
  const fileName = nullableString(value.file_name);
  const nameAlias = nullableString(value.name);
  if (mimeType === null || fileName === null || nameAlias === null) {
    throw new ArtifactError(
      "invalid_openai_file_reference",
      "ChatGPT file reference is malformed.",
    );
  }
  const normalizedFileName = normalizeSuppliedOpenAIFileName(fileName);
  const normalizedNameAlias = normalizeSuppliedOpenAIFileName(nameAlias);
  if (
    normalizedFileName
    && normalizedNameAlias
    && normalizedFileName !== normalizedNameAlias
  ) {
    throw new ArtifactError(
      "ambiguous_openai_file_name",
      "ChatGPT file reference contained conflicting filenames.",
    );
  }

  let size: number | undefined;
  const rawSize = value.size;
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== "number" || !Number.isSafeInteger(rawSize) || rawSize < 0) {
      throw new ArtifactError(
        "invalid_openai_file_reference",
        "ChatGPT file reference is malformed.",
      );
    }
    size = rawSize;
  }

  return {
    download_url: downloadUrl,
    file_id: fileId,
    mime_type: mimeType,
    file_name: normalizedFileName ?? normalizedNameAlias,
    size,
  };
}

function nullableString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null;
}

function normalizeOpenAIFileName(
  suppliedName: string | undefined,
  fileId: string,
  mimeType: string | undefined,
): string {
  if (suppliedName) return suppliedName;
  const safeBaseName = OPENAI_FILENAME_SAFE_FILE_ID_PATTERN.test(fileId)
    ? fileId
    : "chatgpt-file";
  return `${safeBaseName}${extensionForMimeType(mimeType) ?? ".bin"}`;
}

function isValidOpenAIFileId(value: string): boolean {
  return value.length > 0
    && value.length <= OPENAI_FILE_ID_MAX_LENGTH
    && !OPENAI_FILE_ID_CONTROL_PATTERN.test(value);
}

function normalizeSuppliedOpenAIFileName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const candidate = basename(normalized).trim();
  if (!candidate || candidate === "." || candidate === ".." || candidate.startsWith(".")) {
    return undefined;
  }
  return candidate;
}

function extensionForMimeType(mimeType: string | undefined): string | undefined {
  switch (mimeType?.toLowerCase()) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    case "application/zip": return ".zip";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return ".docx";
    default: return undefined;
  }
}

function validateOpenAIFileUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactError(
      "unsafe_openai_file_reference",
      "ChatGPT file download URL is invalid.",
    );
  }
  if (
    url.protocol !== "https:"
    || !OPENAI_FILE_HOSTS.has(url.hostname)
    || (url.port !== "" && url.port !== "443")
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new ArtifactError(
      "unsafe_openai_file_reference",
      "ChatGPT file download URL is outside the trusted file host.",
    );
  }
  return url.toString();
}

function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function responseMimeType(response: Response): string | undefined {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  return value || undefined;
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyValueString(
  value: string,
): "absolute-path" | "url" | "data-url" | "text" {
  if (value.startsWith("data:")) return "data-url";
  if (isAbsolute(value)) return "absolute-path";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return "url";
  } catch {
    // Non-URL strings are summarized only by type and length.
  }
  return "text";
}

function safeValueEntryKey(value: string, index: number): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u.test(value)
    ? value
    : `<redacted-key-${index + 1}>`;
}

function safeConstructorName(value: object): string | undefined {
  try {
    const name = value.constructor?.name;
    return typeof name === "string" && name.length <= 80 ? name : undefined;
  } catch {
    return undefined;
  }
}
