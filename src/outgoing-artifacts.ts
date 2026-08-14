import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { ArtifactError } from "./artifact-error.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".bz2",
  ".db",
  ".doc",
  ".docx",
  ".dylib",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tif",
  ".tiff",
  ".wav",
  ".wasm",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
]);

const MIME_TYPES = new Map<string, string>([
  [".7z", "application/x-7z-compressed"],
  [".avif", "image/avif"],
  [".bin", "application/octet-stream"],
  [".bmp", "image/bmp"],
  [".bz2", "application/x-bzip2"],
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".wav", "audio/wav"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xml", "application/xml"],
  [".xz", "application/x-xz"],
  [".zip", "application/zip"],
]);

export interface ExportedWorkspaceFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  uri: string;
  blob: string;
}

export async function exportWorkspaceFile({
  workspaceId,
  workspaceRoot,
  maxFileBytes,
  path,
  mimeType,
}: {
  workspaceId: string;
  workspaceRoot: string;
  maxFileBytes: number;
  path: string;
  mimeType?: string;
}): Promise<ExportedWorkspaceFile> {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactError(
      "artifact_limit_invalid",
      "Artifact file-size limit must be a positive integer.",
    );
  }
  if (!workspaceId) {
    throw new ArtifactError(
      "artifact_workspace_invalid",
      "A selected workspace is required for native file export.",
    );
  }

  const normalizedPath = normalizeArtifactSource(path);
  const resolvedRoot = await realpath(workspaceRoot).catch(() => {
    throw new ArtifactError(
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
    );
  });
  const candidatePath = resolve(workspaceRoot, normalizedPath);
  const resolvedSource = await realpath(candidatePath).catch(() => {
    throw new ArtifactError(
      "artifact_source_unavailable",
      "Requested workspace file does not exist or cannot be read.",
    );
  });

  if (!isPathInsideRoot(resolvedSource, resolvedRoot)) {
    throw new ArtifactError(
      "artifact_source_unsafe",
      "Requested workspace file resolves outside the selected workspace.",
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(resolvedSource, fsConstants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new ArtifactError(
        "artifact_source_not_file",
        "Requested workspace path must identify a regular file.",
      );
    }
    if (before.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Workspace file exceeds the configured per-file limit.",
      );
    }

    const pathEntry = await lstat(resolvedSource);
    assertSameFile(pathEntry, before);

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new ArtifactError(
        "artifact_source_changed",
        "Workspace file changed while it was being exported.",
      );
    }

    const name = basename(normalizedPath);
    const resolvedMimeType = normalizeMimeType(mimeType) ?? inferMimeType(name);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return {
      path: normalizedPath,
      name,
      mimeType: resolvedMimeType,
      size: bytes.length,
      sha256,
      uri: `devspace://artifact/${randomUUID()}/${encodeURIComponent(name)}`,
      blob: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(
      "artifact_source_unavailable",
      "Requested workspace file does not exist or cannot be read.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function inferMimeType(name: string): string {
  return MIME_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";
}

export function isLikelyBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(extname(name).toLowerCase());
}

export function isModelImageMimeType(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
    mimeType.toLowerCase(),
  );
}

function normalizeMimeType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)) {
    throw new ArtifactError(
      "artifact_mime_type_invalid",
      "MIME type must use a valid type/subtype form.",
    );
  }
  return normalized;
}

function normalizeArtifactSource(value: string): string {
  const rawParts = value.split(sep);
  if (
    !value
    || value.includes("\u0000")
    || isAbsolute(value)
    || value.endsWith(sep)
    || rawParts.includes("..")
  ) {
    throw new ArtifactError(
      "artifact_source_invalid",
      "Artifact source must be a non-empty relative file path inside the workspace.",
    );
  }

  const normalized = normalize(value);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new ArtifactError(
      "artifact_source_invalid",
      "Artifact source must stay inside the selected workspace.",
    );
  }

  const name = basename(normalized);
  if (!name || name === "." || name === "..") {
    throw new ArtifactError(
      "artifact_source_invalid",
      "Artifact source must name a file inside the selected workspace.",
    );
  }
  return normalized;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === ""
    || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function assertSameFile(
  pathEntry: Awaited<ReturnType<typeof lstat>>,
  openedEntry: Awaited<ReturnType<FileHandle["stat"]>>,
): void {
  if (
    pathEntry.isSymbolicLink()
    || !pathEntry.isFile()
    || pathEntry.dev !== openedEntry.dev
    || pathEntry.ino !== openedEntry.ino
    || pathEntry.size !== openedEntry.size
  ) {
    throw new ArtifactError(
      "artifact_source_changed",
      "Workspace file changed before it could be exported.",
    );
  }
}
