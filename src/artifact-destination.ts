import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { ArtifactError } from "./artifact-error.js";
import type { JsonValue } from "./json-value.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export interface ArtifactFile {
  writeAll(buffer: Buffer, position: number): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

export interface ArtifactEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  uid: number;
}

export interface ArtifactDestinationDirectory {
  createExclusiveFile(name: string, mode: number): Promise<ArtifactFile>;
  statRegularFile(name: string): Promise<ArtifactEntry | undefined>;
  link(sourceName: string, destinationName: string): Promise<void>;
  unlink(name: string): Promise<void>;
  listEntries(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export function createPathArtifactDestinationDirectory(
  anchorPath: string,
  close: () => Promise<void>,
): ArtifactDestinationDirectory {
  return {
    async createExclusiveFile(name, mode) {
      const handle = await open(
        join(anchorPath, name),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        mode,
      );

      return artifactFileFromHandle(handle);
    },
    async statRegularFile(name) {
      let entry: Stats;

      try {
        entry = await lstat(join(anchorPath, name));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }

      return !entry.isSymbolicLink() && entry.isFile()
        ? artifactEntryFromStats(entry)
        : undefined;
    },
    link(sourceName, destinationName) {
      return link(join(anchorPath, sourceName), join(anchorPath, destinationName));
    },
    unlink(name) {
      return unlink(join(anchorPath, name));
    },
    listEntries() {
      return readdir(anchorPath);
    },
    close,
  };
}

export function assertSameArtifactEntry(
  entry: ArtifactEntry | undefined,
  expected: Stats,
  code: "artifact_partial_unsafe" | "artifact_destination_publish_failed",
): void {
  if (
    !entry
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

function artifactEntryFromStats(entry: Stats): ArtifactEntry {
  return {
    dev: entry.dev,
    ino: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    uid: entry.uid,
  };
}

function artifactFileFromHandle(handle: FileHandle): ArtifactFile {
  return {
    async writeAll(buffer, position) {
      let offset = 0;

      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(
          buffer,
          offset,
          buffer.length - offset,
          position + offset,
        );

        if (bytesWritten <= 0) {
          throw new ArtifactError(
            "artifact_short_write",
            "Native file was not fully written.",
          );
        }

        offset += bytesWritten;
      }
    },
    sync: () => handle.sync(),
    stat: () => handle.stat(),
    close: () => handle.close(),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
