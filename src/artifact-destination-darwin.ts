import type { WireInput } from "./json-value.js";
import {
  close,
  constants as fsConstants,
  fstat,
  fsync,
  write,
  type Stats,
} from "node:fs";
import koffi from "koffi";
import type {
  ArtifactEntry,
  ArtifactDestinationDirectory,
  ArtifactFile,
} from "./artifact-destination.js";
import { ArtifactError } from "./artifact-error.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = 0x01000000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW | O_CLOEXEC;
const AT_SYMLINK_NOFOLLOW = 0x0020;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export async function prepareDarwinArtifactDestinationDirectory(
  workspaceRoot: string,
  parentParts: readonly string[],
): Promise<ArtifactDestinationDirectory> {
  const libc = darwinLibc();
  const directoryFds: number[] = [];
  let rootFd = libc.open(workspaceRoot, DIRECTORY_FLAGS);

  if (rootFd < 0) {
    throw new ArtifactError(
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
    );
  }

  let parentFd = rootFd;

  try {
    for (const part of parentParts) {
      if (
        libc.mkdirat(parentFd, part, 0o755) < 0
        && koffi.errno() !== koffi.os.errno.EEXIST
      ) {
        throw new ArtifactError(
          "artifact_destination_parent_unsafe",
          "Artifact destination parent could not be created safely.",
        );
      }

      const childFd = libc.openat(parentFd, part, DIRECTORY_FLAGS);

      if (childFd < 0) {
        throw new ArtifactError(
          "artifact_destination_parent_unsafe",
          "Artifact destination parent must be a real directory inside the workspace.",
        );
      }

      directoryFds.push(childFd);
      parentFd = childFd;
    }

    const finalParentFd = parentFd;

    return {
      async createExclusiveFile(name, mode) {
        const fd = libc.openat(
          finalParentFd,
          name,
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | NO_FOLLOW
            | O_CLOEXEC,
          mode,
        );

        if (fd < 0) {
          throw new ArtifactError(
            "artifact_partial_unsafe",
            "Native file partial could not be created safely.",
          );
        }

        return artifactFileFromFd(fd);
      },
      async statRegularFile(name) {
        // Darwin's LP64 struct stat is 144 bytes. Use a raw buffer here instead
        // of nested Koffi output marshalling, then read only the fields we need.
        const entry = Buffer.alloc(144);

        if (libc.fstatat(finalParentFd, name, entry, AT_SYMLINK_NOFOLLOW) < 0) {
          const errno = koffi.errno();

          if (errno === koffi.os.errno.ENOENT) return undefined;
          throw new ArtifactError(
            "artifact_entry_unsafe",
            `Artifact entry could not be inspected safely (errno ${errno}).`,
          );
        }

        return darwinArtifactEntry(entry);
      },
      async link(sourceName, destinationName) {
        if (libc.linkat(finalParentFd, sourceName, finalParentFd, destinationName, 0) === 0) {
          return;
        }

        const errno = koffi.errno();

        if (errno === koffi.os.errno.EEXIST) {
          // SAFETY: The surrounding checks or construction already match this type.
          const error = new Error("Artifact destination already exists.") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }

        throw new ArtifactError(
          "artifact_destination_publish_failed",
          `Native file could not be published at the requested destination (errno ${errno}).`,
        );
      },
      async unlink(name) {
        if (libc.unlinkat(finalParentFd, name, 0) === 0) return;
        const errno = koffi.errno();

        if (errno === koffi.os.errno.ENOENT) return;
        throw new Error(`Could not unlink artifact entry (errno ${errno}).`);
      },
      listEntries: () => listDirectoryEntries(finalParentFd, libc),
      async close() {
        for (const fd of directoryFds.reverse()) {
          await closeFd(fd).catch(() => undefined);
        }

        if (rootFd >= 0) {
          await closeFd(rootFd).catch(() => undefined);
          rootFd = -1;
        }
      },
    };
  } catch (error) {
    for (const fd of directoryFds.reverse()) {
      await closeFd(fd).catch(() => undefined);
    }

    await closeFd(rootFd).catch(() => undefined);
    throw error;
  }
}

interface DarwinLibc {
  open(path: string, flags: number, mode?: number): number;
  openat(fd: number, path: string, flags: number, mode?: number): number;
  mkdirat(fd: number, path: string, mode: number): number;
  fstatat(fd: number, path: string, stat: Buffer, flags: number): number;
  linkat(oldFd: number, oldPath: string, newFd: number, newPath: string, flags: number): number;
  unlinkat(fd: number, path: string, flags: number): number;
  dup(fd: number): number;
  fdopendir(fd: number): WireInput;
  readdir(dir: WireInput): WireInput;
  closedir(dir: WireInput): number;
  DIRENT: ReturnType<typeof koffi.struct>;
}

let cachedDarwinLibc: DarwinLibc | undefined;

function darwinLibc(): DarwinLibc {
  cachedDarwinLibc ??= createDarwinLibc();

  return cachedDarwinLibc;
}

function createDarwinLibc(): DarwinLibc {
  const libc = koffi.load("/usr/lib/libSystem.B.dylib");
  const open = libc.func("int open(const char *path, int flags, ...)");
  const openat = libc.func("int openat(int fd, const char *path, int flags, ...)");
  const DIR = koffi.opaque("DevSpaceArtifactDarwinDIR");
  const DIR_PTR = koffi.pointer(DIR);

  const DIRENT = koffi.struct("DevSpaceArtifactDarwinDirent", {
    d_ino: "uint64_t",
    d_seekoff: "uint64_t",
    d_reclen: "uint16_t",
    d_namlen: "uint16_t",
    d_type: "uint8_t",
    d_name: koffi.array("char", 1024, "String"),
  });

  const DIRENT_PTR = koffi.pointer(DIRENT);

  // SAFETY: The surrounding checks or construction already match this type.
  return {
    open(path, flags, mode) {
      return mode === undefined ? open(path, flags) : open(path, flags, "int", mode);
    },
    openat(fd, path, flags, mode) {
      return mode === undefined
        ? openat(fd, path, flags)
        : openat(fd, path, flags, "int", mode);
    },
    mkdirat: libc.func("mkdirat", "int", ["int", "str", "uint32_t"]),
    fstatat: libc.func(
      "fstatat",
      "int",
      ["int", "str", "void *", "int"],
    ),
    linkat: libc.func("linkat", "int", ["int", "str", "int", "str", "int"]),
    unlinkat: libc.func("unlinkat", "int", ["int", "str", "int"]),
    dup: libc.func("dup", "int", ["int"]),
    fdopendir: libc.func("fdopendir", DIR_PTR, ["int"]),
    readdir: libc.func("readdir", DIRENT_PTR, [DIR_PTR]),
    closedir: libc.func("closedir", "int", [DIR_PTR]),
    DIRENT,
  } as DarwinLibc;
}

function darwinArtifactEntry(entry: Buffer): ArtifactEntry | undefined {
  const mode = entry.readUInt16LE(4);

  if ((mode & S_IFMT) !== S_IFREG) return undefined;

  const mtimeSeconds = Number(entry.readBigInt64LE(48));
  const mtimeNanoseconds = Number(entry.readBigInt64LE(56));

  return {
    dev: entry.readInt32LE(0),
    ino: Number(entry.readBigUInt64LE(8)),
    size: Number(entry.readBigInt64LE(96)),
    uid: entry.readUInt32LE(16),
    mtimeMs: (mtimeSeconds * 1_000) + (mtimeNanoseconds / 1_000_000),
  };
}

async function listDirectoryEntries(
  parentFd: number,
  libc: DarwinLibc,
): Promise<readonly string[]> {
  const duplicateFd = libc.dup(parentFd);

  if (duplicateFd < 0) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination directory could not be inspected safely.",
    );
  }

  const directory = libc.fdopendir(duplicateFd);

  if (directory === null) {
    await closeFd(duplicateFd).catch(() => undefined);
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination directory could not be inspected safely.",
    );
  }

  try {
    const entries: string[] = [];

    while (true) {
      koffi.errno(0);
      const pointer = libc.readdir(directory);

      if (pointer === null) {
        const errno = koffi.errno();

        if (errno !== 0) {
          throw new ArtifactError(
            "artifact_directory_unsafe",
            `Artifact destination directory enumeration failed (errno ${errno}).`,
          );
        }

        return entries;
      }

      // SAFETY: The surrounding checks or construction already match this type.
      const entry = koffi.decode(pointer, libc.DIRENT) as { d_name?: string };
      const name = entry.d_name;

      if (name && name !== "." && name !== "..") entries.push(name);
    }
  } finally {
    libc.closedir(directory);
  }
}

function artifactFileFromFd(fd: number): ArtifactFile {
  let open = true;

  return {
    async writeAll(buffer, position) {
      let offset = 0;

      while (offset < buffer.length) {
        const bytesWritten = await writeFd(
          fd,
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
    sync: () => fsyncFd(fd),
    stat: () => fstatFd(fd),
    async close() {
      if (!open) return;
      open = false;
      await closeFd(fd);
    },
  };
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

function fsyncFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsync(fd, (error) => error ? reject(error) : resolve());
  });
}

function fstatFd(fd: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    fstat(fd, (error, stats) => error ? reject(error) : resolve(stats));
  });
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    close(fd, (error) => error ? reject(error) : resolve());
  });
}
