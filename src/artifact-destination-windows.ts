import { constants as fsConstants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import koffi from "koffi";
import { ArtifactError } from "./artifact-error.js";

export interface WindowsArtifactDestinationDirectory {
  handle: FileHandle;
  anchorPath: string;
  close(): Promise<void>;
}

export async function prepareWindowsArtifactDestinationDirectory(
  workspaceRoot: string,
  parentParts: readonly string[],
): Promise<WindowsArtifactDestinationDirectory> {
  const pinnedHandles: unknown[] = [];
  let directoryHandle: FileHandle | undefined;
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

    directoryHandle = await open(parentPath, fsConstants.O_RDONLY);
    const entry = await directoryHandle.stat();
    if (!entry.isDirectory()) {
      throw new ArtifactError(
        "artifact_destination_parent_unsafe",
        "Artifact destination parent is not a directory.",
      );
    }

    return {
      handle: directoryHandle,
      anchorPath: parentPath,
      async close() {
        await directoryHandle?.close().catch(() => undefined);
        closeWindowsHandles(pinnedHandles);
      },
    };
  } catch (error) {
    await directoryHandle?.close().catch(() => undefined);
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

  // Omitting FILE_SHARE_DELETE keeps each path component pinned against
  // rename/replacement while path-based Node operations run beneath it.
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
  if (handle === null || koffi.address(handle) === BigInt.asUintN(pointerBits, -1n)) {
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
  if (handles.length === 0) return;
  const api = windowsApi();
  for (const handle of handles.reverse()) api.CloseHandle(handle);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
