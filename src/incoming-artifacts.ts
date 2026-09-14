import { basename, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { ArtifactError } from "./artifact-error.js";

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const OPENAI_FILE_HOSTS = new Set([
  "files.oaiusercontent.com",
]);

// ChatGPT-generated files are served from regional OpenAI-managed Azure storage
// accounts. Accept that account family only, never arbitrary Azure Blob hosts.
const OPENAI_REGIONAL_BLOB_HOST_PATTERN = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/u;

const OPENAI_FILENAME_SAFE_FILE_ID_PATTERN = /^file[-_][A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

const OPENAI_FILE_ID_MAX_LENGTH = 512;

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
  canHandle(value: IncomingArtifactInput): boolean;
  open(value: IncomingArtifactInput): Promise<IncomingArtifactSource>;
}

type IncomingArtifactInput =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | (() => void)
  | Buffer
  | readonly IncomingArtifactInput[]
  | { readonly [key: string]: IncomingArtifactInput };

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

  async open(value: IncomingArtifactInput): Promise<OpenedIncomingArtifact> {
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

type OpenAIFileReferenceInput = { readonly [key: string]: IncomingArtifactInput };

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
    async open(value: IncomingArtifactInput): Promise<IncomingArtifactSource> {
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
        // SAFETY: Response.body is a web ReadableStream, which Node's adapter accepts.
        stream: Readable.fromWeb(response.body as NodeReadableStream),
      };
    },
  };
}

export type IncomingArtifactValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean" }
  | { type: "number"; finite: boolean }
  | { type: "bigint" }
  | { type: "string"; kind: "absolute-path" | "url" | "data-url" | "text"; length: number }
  | { type: "array"; length: number; items: IncomingArtifactValue[]; truncated: boolean }
  | {
      type: "object";
      constructor?: string;
      entries: Record<string, IncomingArtifactValue>;
      truncated: boolean;
    }
  | { type: "function" | "symbol" }
  | { type: "cycle" };

type InspectableValue = IncomingArtifactInput;

const inspectableValueSchema = z.custom<InspectableValue>(() => true);

function parseInspectableValue(value: IncomingArtifactInput): InspectableValue {
  return inspectableValueSchema.parse(value);
}

export function describeIncomingArtifactValue(
  value: IncomingArtifactInput,
  maxDepth = 4,
  maxEntries = 20,
): IncomingArtifactValue {
  const seen = new WeakSet<object>();

  const describe = (current: InspectableValue, depth: number): IncomingArtifactValue => {
    if (current === null) return { type: "null" };

    if (current === undefined) return { type: "undefined" };

    const booleanValue = z.boolean().safeParse(current);

    if (booleanValue.success) return { type: "boolean" };

    if (
      Object.is(current, Infinity)
      || Object.is(current, -Infinity)
      || Object.is(current, Number.NaN)
    ) {
      return { type: "number", finite: false };
    }

    const numberValue = z.number().safeParse(current);

    if (numberValue.success) return { type: "number", finite: Number.isFinite(numberValue.data) };

    if (z.bigint().safeParse(current).success) return { type: "bigint" };

    if (z.function().safeParse(current).success) return { type: "function" };

    if (z.symbol().safeParse(current).success) return { type: "symbol" };

    const stringValue = z.string().safeParse(current);

    if (stringValue.success) {
      return {
        type: "string",
        kind: classifyValueString(stringValue.data),
        length: stringValue.data.length,
      };
    }

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

    const objectValue = z.object({}).passthrough().parse(current);

    if (seen.has(objectValue)) return { type: "cycle" };
    seen.add(objectValue);

    const keys = Object.keys(objectValue).sort();

    if (depth >= maxDepth) {
      return {
        type: "object",
        constructor: safeConstructorName(current),
        entries: {},
        truncated: keys.length > 0,
      };
    }

    const entries: Record<string, IncomingArtifactValue> = {};

    for (const [index, key] of keys.slice(0, maxEntries).entries()) {
      let entryValue: InspectableValue;

      try {
        entryValue = inspectableValueSchema.parse(objectValue[key]);
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

  return describe(parseInspectableValue(value), 0);
}

function validateIncomingArtifactSource(source: IncomingArtifactSource): void {
  if (!source || Object.prototype.toString.call(source) !== "[object Object]") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter returned an invalid source.",
    );
  }

  if (Object.prototype.toString.call(source.name) !== "[object String]" || source.name.length === 0) {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide a filename.",
    );
  }

  if (source.mimeType !== undefined && Object.prototype.toString.call(source.mimeType) !== "[object String]") {
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

  const stream: Partial<Readable> | undefined = source.stream;

  if (!stream || Object.prototype.toString.call(stream[Symbol.asyncIterator]) !== "[object Function]") {
    throw new ArtifactError(
      "invalid_incoming_artifact_source",
      "Incoming artifact adapter must provide an async-readable stream.",
    );
  }
}

function isOpenAIFileReferenceCandidate(value: IncomingArtifactInput): value is OpenAIFileReferenceInput {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);

  return keys.length >= 2
    && keys.every((key) => OPENAI_FILE_KEYS.has(key))
    && Object.hasOwn(value, "download_url")
    && Object.hasOwn(value, "file_id");
}

function normalizeOpenAIFileReference(value: IncomingArtifactInput): OpenAIFileReference {
  if (!isOpenAIFileReferenceCandidate(value)) {
    throw new ArtifactError(
      "invalid_openai_file_reference",
      "ChatGPT file reference is malformed.",
    );
  }

  const downloadUrl = value.download_url;
  const fileId = value.file_id;
  const parsedDownloadUrl = z.string().safeParse(downloadUrl);
  const parsedFileId = z.string().safeParse(fileId);

  if (
    !parsedDownloadUrl.success
    || !parsedFileId.success
    || !isValidOpenAIFileId(parsedFileId.data)
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
    const parsedSize = z.number().safeParse(rawSize);

    if (!parsedSize.success || !Number.isSafeInteger(parsedSize.data) || parsedSize.data < 0) {
      throw new ArtifactError(
        "invalid_openai_file_reference",
        "ChatGPT file reference is malformed.",
      );
    }

    size = parsedSize.data;
  }

  return {
    download_url: parsedDownloadUrl.data,
    file_id: parsedFileId.data,
    mime_type: mimeType,
    file_name: normalizedFileName ?? normalizedNameAlias,
    size,
  };
}

function nullableString(value: IncomingArtifactInput): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  const parsed = z.string().safeParse(value);

  return parsed.success ? parsed.data : null;
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
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;

      return codePoint <= 0x1F || codePoint === 0x7F;
    });
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
    || !isTrustedOpenAIFileHost(url.hostname)
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

function isTrustedOpenAIFileHost(hostname: string): boolean {
  return OPENAI_FILE_HOSTS.has(hostname) || OPENAI_REGIONAL_BLOB_HOST_PATTERN.test(hostname);
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

function isRecord(value: IncomingArtifactInput): value is OpenAIFileReferenceInput {
  return Object.prototype.toString.call(value) === "[object Object]";
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

function safeConstructorName(value: IncomingArtifactInput): string | undefined {
  try {
    const match = /^\[object ([^\]]+)\]$/u.exec(Object.prototype.toString.call(value));
    const name = match?.[1];

    return name && name.length <= 80 ? name : undefined;
  } catch {
    return undefined;
  }
}
