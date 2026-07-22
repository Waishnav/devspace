import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import koffi from "koffi";
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

export async function openWindowsArtifactTarget({
  workspaceRoot,
  parentParts,
  name,
  publishLink,
}: SecureArtifactTargetOptions): Promise<SecureArtifactTarget> {
  const pinnedHandles: unknown[] = [];
  let fileHandle: FileHandle | undefined;
  let partialPath: string | undefined;
  let writtenEntry: FileEntry | undefined;
  let parentPath = workspaceRoot;

  try {
    pinnedHandles.push(pinWindowsDirectory(workspaceRoot, "artifact_workspace_unsafe"));
    for (const part of parentParts) {
      parentPath = join(parentPath, part);
      try {
        await mkdir(parentPath, { mode: 0o755 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      pinnedHandles.push(
        pinWindowsDirectory(parentPath, "artifact_destination_parent_unsafe"),
      );
    }

    await cleanupStalePartials(parentPath);
    partialPath = join(
      parentPath,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    const candidatePath = join(parentPath, name);
    fileHandle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
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
          await publishLink(partialPath!, candidatePath);
          assertSameEntry(
            await lstat(candidatePath),
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
        closeWindowsHandles(pinnedHandles);
      },
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    closeWindowsHandles(pinnedHandles);
    throw error;
  }
}

interface WindowsApi {
  CreateFileW(
    path: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    templateFile: null,
  ): unknown;
  GetFileInformationByHandleEx(
    handle: unknown,
    infoClass: number,
    info: WindowsAttributeInfo,
    size: number,
  ): number;
  CloseHandle(handle: unknown): number;
  HANDLE: ReturnType<typeof koffi.pointer>;
  FILE_ATTRIBUTE_TAG_INFO: ReturnType<typeof koffi.struct>;
}

interface WindowsAttributeInfo {
  FileAttributes?: number;
  ReparseTag?: number;
}

let cachedWindowsApi: WindowsApi | undefined;

function windowsApi(): WindowsApi {
  cachedWindowsApi ??= createWindowsApi();
  return cachedWindowsApi;
}

function createWindowsApi(): WindowsApi {
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("DevSpaceArtifactWindowsHandle", koffi.opaque());
  const FILE_ATTRIBUTE_TAG_INFO = koffi.struct("DevSpaceArtifactFileAttributeTagInfo", {
    FileAttributes: "uint32_t",
    ReparseTag: "uint32_t",
  });
  return {
    CreateFileW: kernel32.func(
      "DevSpaceArtifactWindowsHandle __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    ) as unknown as WindowsApi["CreateFileW"],
    GetFileInformationByHandleEx: kernel32.func(
      "int __stdcall GetFileInformationByHandleEx(DevSpaceArtifactWindowsHandle handle, int infoClass, _Out_ DevSpaceArtifactFileAttributeTagInfo *info, uint32_t size)",
    ) as unknown as WindowsApi["GetFileInformationByHandleEx"],
    CloseHandle: kernel32.func(
      "int __stdcall CloseHandle(DevSpaceArtifactWindowsHandle handle)",
    ) as unknown as WindowsApi["CloseHandle"],
    HANDLE,
    FILE_ATTRIBUTE_TAG_INFO,
  };
}

function pinWindowsDirectory(path: string, code: string): unknown {
  const api = windowsApi();
  const FILE_LIST_DIRECTORY = 0x0001;
  const FILE_TRAVERSE = 0x0020;
  const FILE_READ_ATTRIBUTES = 0x0080;
  const SYNCHRONIZE = 0x00100000;
  const FILE_SHARE_READ = 0x00000001;
  const FILE_SHARE_WRITE = 0x00000002;
  const OPEN_EXISTING = 3;
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;

  const handle = api.CreateFileW(
    toNamespacedPath(path),
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  const pointerBits = koffi.sizeof(api.HANDLE) * 8;
  if (
    handle === null
    || koffi.address(handle) === BigInt.asUintN(pointerBits, -1n)
  ) {
    throw new ArtifactError(code, "Artifact directory could not be pinned safely.");
  }

  const info: WindowsAttributeInfo = {};
  const success = api.GetFileInformationByHandleEx(
    handle,
    FILE_ATTRIBUTE_TAG_INFO_CLASS,
    info,
    koffi.sizeof(api.FILE_ATTRIBUTE_TAG_INFO),
  );
  const attributes = info.FileAttributes ?? 0;
  if (
    !success
    || (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
    || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    api.CloseHandle(handle);
    throw new ArtifactError(
      code,
      "Artifact directory must be a real directory, not a reparse point.",
    );
  }
  return handle;
}

function closeWindowsHandles(handles: unknown[]): void {
  const api = windowsApi();
  for (const handle of handles.reverse()) api.CloseHandle(handle);
}
