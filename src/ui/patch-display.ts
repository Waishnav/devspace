import type { ToolResultCard } from "./card-types.js";

export type FileChangeKind =
  | "added"
  | "edited"
  | "deleted"
  | "renamed"
  | "renamed-edited"
  | "unknown";

type ReviewFile = NonNullable<ToolResultCard["files"]>[number];

export interface FileChangePathDisplay {
  current: string;
  previous?: string;
  title: string;
}

const fileChangeLabels: Record<Exclude<FileChangeKind, "unknown">, string> = {
  added: "Added",
  edited: "Edited",
  deleted: "Deleted",
  renamed: "Renamed",
  "renamed-edited": "Renamed and edited",
};

export function getPatchDisplayParts(
  card: Pick<ToolResultCard, "files">,
  options: { emptyTitle?: string } = {},
): { title: string } {
  const files = card.files ?? [];
  const fileCount = countChangedFiles(files);
  if (fileCount === 0) return { title: options.emptyTitle ?? "Changes ready" };

  const kinds = new Set(files.map(getFileChangeKind));
  const kind = kinds.size === 1 ? [...kinds][0] : undefined;
  const noun = fileCount === 1 ? "file" : "files";
  return {
    title: kind && kind !== "unknown"
      ? `${fileChangeLabels[kind]} ${fileCount} ${noun}`
      : `Changed ${fileCount} ${noun}`,
  };
}

export function getFileChangeKind(file: ReviewFile): FileChangeKind {
  switch (file.type) {
    case "new":
      return "added";
    case "change":
      return "edited";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed-edited";
    default:
      return "unknown";
  }
}

export function getRenderedFileChangeKind(
  files: NonNullable<ToolResultCard["files"]>,
  parsedFile: Pick<ReviewFile, "path" | "previousPath" | "type">,
  index: number,
): FileChangeKind {
  const parsedKind = getFileChangeKind(parsedFile);
  return parsedKind === "unknown"
    ? getFileChangeKind(files[index] ?? {})
    : parsedKind;
}

export function getFileChangePathDisplay(
  file: Pick<ReviewFile, "path" | "previousPath">,
): FileChangePathDisplay | undefined {
  const current = file.path ?? file.previousPath;
  if (!current) return undefined;

  const previous = file.previousPath;
  if (!previous || previous === current) return { current, title: current };

  const sameDirectory = pathDirectory(previous) === pathDirectory(current);
  return {
    current: sameDirectory ? pathBasename(current) : current,
    previous: sameDirectory ? pathBasename(previous) : previous,
    title: `${previous} → ${current}`,
  };
}

export function getRenderedFileChangePathDisplay(
  files: NonNullable<ToolResultCard["files"]>,
  parsedFile: Pick<ReviewFile, "path" | "previousPath">,
  index: number,
): FileChangePathDisplay | undefined {
  const indexedFile = files[index];
  const matchedFile = indexedFile?.path === parsedFile.path
    ? indexedFile
    : files.find((file) => file.path === parsedFile.path);
  const cardFile = matchedFile ?? indexedFile;

  return getFileChangePathDisplay({
    path: parsedFile.path ?? cardFile?.path,
    previousPath: parsedFile.previousPath ?? cardFile?.previousPath,
  });
}

export function fileChangeKindLabel(kind: FileChangeKind): string {
  return kind === "unknown" ? "Changed" : fileChangeLabels[kind];
}

function countChangedFiles(files: NonNullable<ToolResultCard["files"]>): number {
  const paths = new Set<string>();
  let unnamedFiles = 0;
  for (const file of files) {
    const path = file.path ?? file.previousPath;
    if (path) paths.add(path);
    else unnamedFiles += 1;
  }
  return paths.size + unnamedFiles;
}

function pathDirectory(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

function pathBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}
