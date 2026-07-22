import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import koffi from "koffi";
import { ArtifactError } from "./artifact-error.js";
import {
  assertSameEntry,
  assertWrittenEntry,
  closeFd,
  destinationExistsError,
  fstatFd,
  fsyncFd,
  PARTIAL_PREFIX,
  PARTIAL_SUFFIX,
  writeAllFd,
  type FileEntry,
} from "./artifact-secure-filesystem-common.js";
import type {
  SecureArtifactTarget,
  SecureArtifactTargetOptions,
} from "./artifact-secure-filesystem.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = 0x01000000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW;

export async function openDarwinArtifactTarget({
  workspaceRoot,
  parentParts,
  name,
}: SecureArtifactTargetOptions): Promise<SecureArtifactTarget> {
  const libc = darwinLibc();
  const directoryFds: number[] = [];
  let rootFd = -1;
  let fileFd = -1;
  let partialName: string | undefined;
  let writtenEntry: FileEntry | undefined;
  let parentFd = -1;

  try {
    rootFd = libc.open(
      workspaceRoot,
      DIRECTORY_FLAGS | O_CLOEXEC,
      0,
    );
    if (rootFd < 0) {
      throw new ArtifactError(
        "artifact_workspace_unsafe",
        "Selected workspace root is not a real directory.",
      );
    }

    parentFd = rootFd;
    for (const part of parentParts) {
      if (libc.mkdirat(parentFd, part, 0o755) < 0 && koffi.errno() !== koffi.os.errno.EEXIST) {
        throw new ArtifactError(
          "artifact_destination_parent_unsafe",
          "Artifact destination parent could not be created safely.",
        );
      }
      const childFd = libc.openat(
        parentFd,
        part,
        DIRECTORY_FLAGS | O_CLOEXEC,
        0,
      );
      if (childFd < 0) {
        throw new ArtifactError(
          "artifact_destination_parent_unsafe",
          "Artifact destination parent must be a real directory inside the workspace.",
        );
      }
      directoryFds.push(childFd);
      parentFd = childFd;
    }

    partialName = `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`;
    fileFd = libc.openat(
      parentFd,
      partialName,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | NO_FOLLOW
        | O_CLOEXEC,
      0o600,
    );
    if (fileFd < 0) {
      throw new ArtifactError(
        "artifact_partial_unsafe",
        "Native file partial could not be created safely.",
      );
    }

    return {
      writeAll: (buffer, position) => writeAllFd(fileFd, buffer, position),
      async syncAndVerify(expectedSize) {
        await fsyncFd(fileFd);
        writtenEntry = await fstatFd(fileFd);
        assertWrittenEntry(writtenEntry, expectedSize);
        const verificationFd = libc.openat(
          parentFd,
          partialName!,
          fsConstants.O_RDONLY | NO_FOLLOW | O_CLOEXEC,
          0,
        );
        if (verificationFd < 0) throw partialUnsafeError(koffi.errno());
        try {
          assertSameEntry(await fstatFd(verificationFd), writtenEntry, "artifact_partial_unsafe");
        } finally {
          await closeFd(verificationFd).catch(() => undefined);
        }
      },
      async publish() {
        if (!writtenEntry) throw new Error("Artifact must be verified before publication.");
        if (libc.linkat(parentFd, partialName!, parentFd, name, 0) < 0) {
          if (koffi.errno() === koffi.os.errno.EEXIST) throw destinationExistsError();
          throw publicationFailedError();
        }

        const publishedFd = libc.openat(
          parentFd,
          name,
          fsConstants.O_RDONLY | NO_FOLLOW | O_CLOEXEC,
          0,
        );
        if (publishedFd < 0) throw publicationFailedError();
        try {
          assertSameEntry(
            await fstatFd(publishedFd),
            writtenEntry,
            "artifact_destination_publish_failed",
          );
        } finally {
          await closeFd(publishedFd).catch(() => undefined);
        }

        if (libc.unlinkat(parentFd, partialName!, 0) === 0) partialName = undefined;
      },
      async close() {
        if (fileFd >= 0) await closeFd(fileFd).catch(() => undefined);
        if (partialName) libc.unlinkat(parentFd, partialName, 0);
        for (const fd of directoryFds.reverse()) await closeFd(fd).catch(() => undefined);
        if (rootFd >= 0) await closeFd(rootFd).catch(() => undefined);
      },
    };
  } catch (error) {
    if (fileFd >= 0) await closeFd(fileFd).catch(() => undefined);
    if (partialName && parentFd >= 0) libc.unlinkat(parentFd, partialName, 0);
    for (const fd of directoryFds.reverse()) await closeFd(fd).catch(() => undefined);
    if (rootFd >= 0) await closeFd(rootFd).catch(() => undefined);
    throw error;
  }
}

let cachedDarwinLibc: ReturnType<typeof createDarwinLibc> | undefined;

function darwinLibc() {
  cachedDarwinLibc ??= createDarwinLibc();
  return cachedDarwinLibc;
}

function createDarwinLibc() {
  const libc = koffi.load("/usr/lib/libSystem.B.dylib");
  return {
    open: libc.func("int open(const char *path, int flags, uint32_t mode)"),
    openat: libc.func("int openat(int fd, const char *path, int flags, uint32_t mode)"),
    mkdirat: libc.func("int mkdirat(int fd, const char *path, uint32_t mode)"),
    linkat: libc.func(
      "int linkat(int oldfd, const char *oldpath, int newfd, const char *newpath, int flags)",
    ),
    unlinkat: libc.func("int unlinkat(int fd, const char *path, int flags)"),
  };
}

function partialUnsafeError(errno?: number): ArtifactError {
  const suffix = errno === undefined ? "" : ` (errno ${errno})`;
  return new ArtifactError(
    "artifact_partial_unsafe",
    `Native file partial changed before publication${suffix}.`,
  );
}

function publicationFailedError(): ArtifactError {
  return new ArtifactError(
    "artifact_destination_publish_failed",
    "Native file could not be published at the requested destination.",
  );
}
