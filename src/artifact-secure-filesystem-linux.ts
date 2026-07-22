import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactError } from "./artifact-error.js";
import {
  assertSameEntry,
  assertWrittenEntry,
  cleanupStalePartials,
  destinationExistsError,
  isNodeError,
  PARTIAL_PREFIX,
  PARTIAL_SUFFIX,
  writeAllFileHandle,
  type FileEntry,
} from "./artifact-secure-filesystem-common.js";
import type {
  SecureArtifactTarget,
  SecureArtifactTargetOptions,
} from "./artifact-secure-filesystem.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW;

export async function openLinuxArtifactTarget({
  workspaceRoot,
  parentParts,
  name,
  publishLink,
}: SecureArtifactTargetOptions): Promise<SecureArtifactTarget> {
  const directoryHandles: FileHandle[] = [];
  let rootHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  let partialPath: string | undefined;
  let candidatePath: string | undefined;
  let writtenEntry: FileEntry | undefined;

  try {
    rootHandle = await openDirectoryNoFollow(
      workspaceRoot,
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
    );
    let parentHandle = rootHandle;
    let parentAnchor = `/proc/self/fd/${rootHandle.fd}`;
    for (const part of parentParts) {
      await assertDirectoryHandle(parentHandle);
      const childPath = join(parentAnchor, part);
      try {
        await mkdir(childPath, { mode: 0o755 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      const child = await openDirectoryNoFollow(
        childPath,
        "artifact_destination_parent_unsafe",
        "Artifact destination parent must be a real directory inside the workspace.",
      );
      directoryHandles.push(child);
      parentHandle = child;
      parentAnchor = `/proc/self/fd/${child.fd}`;
    }

    await cleanupStalePartials(parentAnchor);
    partialPath = join(
      parentAnchor,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    candidatePath = join(parentAnchor, name);
    fileHandle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );

    return {
      writeAll: (buffer, position) => writeAllFileHandle(fileHandle!, buffer, position),
      async syncAndVerify(expectedSize) {
        await fileHandle!.sync();
        writtenEntry = await fileHandle!.stat();
        assertWrittenEntry(writtenEntry, expectedSize);
        assertSameEntry(await lstat(partialPath!), writtenEntry, "artifact_partial_unsafe");
      },
      async publish() {
        if (!writtenEntry) throw new Error("Artifact must be verified before publication.");
        try {
          await publishLink(partialPath!, candidatePath!);
          assertSameEntry(
            await lstat(candidatePath!),
            writtenEntry,
            "artifact_destination_publish_failed",
          );
          await unlink(partialPath!).catch(() => undefined);
          partialPath = undefined;
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") throw destinationExistsError();
          throw error;
        }
      },
      async close() {
        await fileHandle?.close().catch(() => undefined);
        if (partialPath) await unlink(partialPath).catch(() => undefined);
        for (const handle of directoryHandles.reverse()) {
          await handle.close().catch(() => undefined);
        }
        await rootHandle?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    for (const handle of directoryHandles.reverse()) {
      await handle.close().catch(() => undefined);
    }
    await rootHandle?.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryNoFollow(
  path: string,
  code: string,
  message: string,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, DIRECTORY_FLAGS);
    await assertDirectoryHandle(handle);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(code, message);
  }
}

async function assertDirectoryHandle(handle: FileHandle): Promise<void> {
  const entry = await handle.stat();
  if (!entry.isDirectory()) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination parent is not a directory.",
    );
  }
}
