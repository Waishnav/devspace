import type { PatchOperation, ToolResultCard } from "./card-types.js";

export interface PatchDisplayParts {
  title: string;
  iconOperation?: PatchOperation;
  tone: "edit" | "write";
}

const patchOperationLabels: Record<PatchOperation, string> = {
  add: "Write",
  update: "Edit",
  delete: "Delete",
  move: "Move",
};

export function getPatchDisplayParts(card: Pick<ToolResultCard, "files">): PatchDisplayParts {
  const files = card.files ?? [];
  const operations = patchOperations(files);

  if (operations.length === 0) {
    return { title: "Apply Patch", tone: "edit" };
  }

  const singleOperation = operations.length === 1 ? operations[0] : undefined;

  const display: PatchDisplayParts = {
    title: patchTitle(operations, countChangedFiles(files)),
    tone: singleOperation === "add" ? "write" : "edit",
  };
  if (singleOperation) display.iconOperation = singleOperation;
  return display;
}

function patchOperations(files: NonNullable<ToolResultCard["files"]>): PatchOperation[] {
  const operations = new Set<PatchOperation>();
  for (const file of files) {
    if (file.operation) operations.add(file.operation);
  }
  return [...operations];
}

function countChangedFiles(files: NonNullable<ToolResultCard["files"]>): number {
  const paths = new Set<string>();
  let unnamedFiles = 0;

  for (const file of files) {
    const path = file.path ?? file.previousPath;
    if (path) {
      paths.add(path);
    } else {
      unnamedFiles += 1;
    }
  }

  return paths.size + unnamedFiles;
}

function patchTitle(operations: PatchOperation[], fileCount: number): string {
  if (operations.length === 1) {
    return `${patchOperationLabels[operations[0]]} ${fileNoun(fileCount)}`;
  }

  return `${joinTitleParts(operations.map((operation) => patchOperationLabels[operation]))} ${fileNoun(fileCount)}`;
}

function fileNoun(fileCount: number): "File" | "Files" {
  return fileCount === 1 ? "File" : "Files";
}

function joinTitleParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} & ${parts.at(-1)}`;
}
