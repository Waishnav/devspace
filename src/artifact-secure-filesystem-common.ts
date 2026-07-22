import { close, fstat, fsync, write } from "node:fs";
import { lstat, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactError } from "./artifact-error.js";

export const PARTIAL_PREFIX = ".devspace-download-";
export const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_PARTIAL_CLEANUP = 32;

export type FileEntry = Awaited<ReturnType<FileHandle["stat"]>>;

export async function writeAllFileHandle(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw shortWriteError();
    offset += bytesWritten;
  }
}

export async function writeAllFd(
  fd: number,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = await writeFd(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw shortWriteError();
    offset += bytesWritten;
  }
}

export function fsyncFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsync(fd, (error) => error ? reject(error) : resolve());
  });
}

export function fstatFd(fd: number): Promise<FileEntry> {
  return new Promise((resolve, reject) => {
    fstat(fd, (error, stats) => error ? reject(error) : resolve(stats));
  });
}

export function closeFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    close(fd, (error) => error ? reject(error) : resolve());
  });
}

export function assertWrittenEntry(entry: FileEntry, expectedSize: number): void {
  if (!entry.isFile() || entry.size !== expectedSize) {
    throw new ArtifactError(
      "artifact_write_integrity_failed",
      "Native file could not be verified before publication.",
    );
  }
}

export function assertSameEntry(
  entry: FileEntry,
  expected: FileEntry,
  code: "artifact_partial_unsafe" | "artifact_destination_publish_failed",
): void {
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || entry.dev !== expected.dev
    || entry.ino !== expected.ino
    || entry.size !== expected.size
  ) {
    throw new ArtifactError(
      code,
      code === "artifact_partial_unsafe"
        ? "Native file partial changed before publication."
        : "Published artifact did not match the verified download.",
    );
  }
}

export async function cleanupStalePartials(directoryPath: string): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
  for (const entry of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;
    if (!entry.name.startsWith(PARTIAL_PREFIX) || !entry.name.endsWith(PARTIAL_SUFFIX)) {
      continue;
    }
    inspected += 1;
    const path = join(directoryPath, entry.name);
    const metadata = await lstatOrUndefined(path);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await unlink(path).catch(() => undefined);
  }
}

export function destinationExistsError(): ArtifactError {
  return new ArtifactError("artifact_destination_exists", "Artifact destination already exists.");
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function writeFd(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, buffer, offset, length, position, (error, bytesWritten) => {
      if (error) reject(error);
      else resolve(bytesWritten);
    });
  });
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function shortWriteError(): ArtifactError {
  return new ArtifactError("artifact_short_write", "Native file was not fully written.");
}
