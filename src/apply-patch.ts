import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface AppliedPatchFile {
  path: string;
  previousPath?: string;
  operation: PatchOperation;
}

export interface ApplyPatchResult {
  files: AppliedPatchFile[];
  patch: string;
  additions: number;
  removals: number;
}

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface UpdateHunk {
  lines: HunkLine[];
}

type PatchAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: UpdateHunk[] };

interface StagedFile {
  content: string;
  mode?: number;
}

function patchError(message: string): Error {
  return new Error(`Invalid patch: ${message}`);
}

export function parsePatch(patch: string): PatchAction[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch") {
    throw patchError("missing *** Begin Patch marker");
  }
  if (lines.pop() !== "*** End Patch") {
    throw patchError("missing *** End Patch marker");
  }

  const actions: PatchAction[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index++];

    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const line = lines[index++];
        if (!line.startsWith("+")) {
          throw patchError(`added file line must start with +: ${line}`);
        }
        content.push(line.slice(1));
      }
      actions.push({
        kind: "add",
        path,
        content: content.length > 0 ? `${content.join("\n")}\n` : "",
      });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      actions.push({ kind: "delete", path: header.slice("*** Delete File: ".length) });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      let moveTo: string | undefined;
      const hunks: UpdateHunk[] = [];

      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index++].slice("*** Move to: ".length);
      }

      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const hunkHeader = lines[index++];
        if (!hunkHeader.startsWith("@@")) {
          throw patchError(`expected hunk header, received: ${hunkHeader}`);
        }

        const hunkLines: HunkLine[] = [];
        while (
          index < lines.length &&
          !lines[index].startsWith("@@") &&
          !lines[index].startsWith("*** ")
        ) {
          const line = lines[index++];
          if (line.startsWith(" ")) hunkLines.push({ kind: "context", text: line.slice(1) });
          else if (line.startsWith("+")) hunkLines.push({ kind: "add", text: line.slice(1) });
          else if (line.startsWith("-")) hunkLines.push({ kind: "remove", text: line.slice(1) });
          else if (line === "\\ No newline at end of file") continue;
          else throw patchError(`hunk line must start with space, +, or -: ${line}`);
        }

        if (hunkLines.length === 0) throw patchError(`empty update hunk for ${path}`);
        hunks.push({ lines: hunkLines });
      }

      if (hunks.length === 0 && !moveTo) {
        throw patchError(`update for ${path} has no hunks or move destination`);
      }
      actions.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    throw patchError(`unknown action header: ${header}`);
  }

  if (actions.length === 0) throw patchError("contains no file actions");
  return actions;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveConfinedPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) {
    throw patchError(`path must be relative to the workspace: ${input}`);
  }

  const rootPath = await realpath(root);
  const target = resolve(rootPath, input);
  if (!isInside(rootPath, target)) {
    throw patchError(`path escapes the workspace: ${input}`);
  }

  let existing = target;
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (!isInside(rootPath, resolved)) {
        throw patchError(`path resolves outside the workspace: ${input}`);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  return target;
}

function splitFile(content: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function findSequence(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return from;

  const matchAt = (index: number, normalize: (value: string) => string): boolean =>
    needle.every((line, offset) => normalize(haystack[index + offset] ?? "") === normalize(line));

  for (const normalize of [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ]) {
    for (let index = from; index <= haystack.length - needle.length; index += 1) {
      if (matchAt(index, normalize)) return index;
    }
  }

  return -1;
}

function applyHunks(path: string, content: string, hunks: UpdateHunk[]): string {
  const file = splitFile(content);
  const lines = [...file.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const index = findSequence(lines, oldLines, cursor);

    if (index < 0) {
      const preview = oldLines.slice(0, 3).join("\n");
      throw patchError(`could not find hunk context in ${path}: ${preview}`);
    }

    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }

  const normalized = lines.join("\n") + (file.finalNewline ? "\n" : "");
  return file.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function replaceFile(
  temporary: string,
  destination: string,
  destinationExists: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32" || !destinationExists) {
    await rename(temporary, destination);
    return;
  }

  const backup = `${temporary}.original`;
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination);
    throw error;
  }
  await rm(backup, { force: true });
}

export async function applyPatch(root: string, patch: string): Promise<ApplyPatchResult> {
  const actions = parsePatch(patch);
  const staged = new Map<string, StagedFile | null>();
  const originals = new Map<string, { content: string | null; path: string }>();
  const currentPaths = new Map<string, string>();
  const results: AppliedPatchFile[] = [];

  const rememberOriginal = (
    absolute: string,
    displayPath: string,
    content: string | null,
  ): void => {
    if (!originals.has(absolute)) originals.set(absolute, { content, path: displayPath });
    currentPaths.set(absolute, displayPath);
  };

  const load = async (displayPath: string): Promise<{ absolute: string; file: StagedFile }> => {
    const absolute = await resolveConfinedPath(root, displayPath);
    if (staged.has(absolute)) {
      const file = staged.get(absolute);
      if (!file) throw patchError(`file does not exist: ${displayPath}`);
      return { absolute, file };
    }
    if (!(await fileExists(absolute))) throw patchError(`file does not exist: ${displayPath}`);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`);
    const file = { content: await readFile(absolute, "utf8"), mode: metadata.mode };
    rememberOriginal(absolute, displayPath, file.content);
    staged.set(absolute, file);
    return { absolute, file };
  };

  for (const action of actions) {
    if (action.kind === "add") {
      const absolute = await resolveConfinedPath(root, action.path);
      if (staged.get(absolute) || (!staged.has(absolute) && (await fileExists(absolute)))) {
        throw patchError(`file already exists: ${action.path}`);
      }
      rememberOriginal(absolute, action.path, null);
      staged.set(absolute, { content: action.content });
      results.push({ path: action.path, operation: "add" });
      continue;
    }

    const { absolute, file } = await load(action.path);

    if (action.kind === "delete") {
      staged.set(absolute, null);
      results.push({ path: action.path, operation: "delete" });
      continue;
    }

    const updated = applyHunks(action.path, file.content, action.hunks);
    if (action.moveTo) {
      const destination = await resolveConfinedPath(root, action.moveTo);
      if (
        destination !== absolute &&
        (staged.get(destination) || (!staged.has(destination) && (await fileExists(destination))))
      ) {
        throw patchError(`move destination already exists: ${action.moveTo}`);
      }
      rememberOriginal(destination, action.moveTo, null);
      staged.set(absolute, null);
      staged.set(destination, { content: updated, mode: file.mode });
      results.push({ path: action.moveTo, previousPath: action.path, operation: "move" });
    } else {
      staged.set(absolute, { content: updated, mode: file.mode });
      results.push({ path: action.path, operation: "update" });
    }
  }

  const patches = Array.from(staged, ([absolute, file]) => {
    const original = originals.get(absolute);
    if (!original || original.content === file?.content) return "";
    return unifiedFilePatch(
      original.path,
      currentPaths.get(absolute) ?? original.path,
      original.content,
      file?.content ?? null,
    );
  }).filter(Boolean);
  const unifiedPatch = patches.join("\n");
  const stats = countPatchStats(unifiedPatch);

  const pendingWrites: Array<{
    temporary: string;
    destination: string;
    destinationExists: boolean;
  }> = [];
  for (const [destination, file] of staged) {
    if (!file) continue;
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.devspace-patch-${process.pid}-${pendingWrites.length}`;
    await writeFile(temporary, file.content, file.mode === undefined ? undefined : { mode: file.mode });
    pendingWrites.push({
      temporary,
      destination,
      destinationExists: originals.get(destination)?.content !== null,
    });
  }

  try {
    for (const write of pendingWrites) {
      await replaceFile(write.temporary, write.destination, write.destinationExists);
    }
    for (const [path, file] of staged) {
      if (!file) await rm(path, { force: true });
    }
  } catch (error) {
    await Promise.all(pendingWrites.map(({ temporary }) => rm(temporary, { force: true })));
    throw error;
  }

  return { files: results, patch: unifiedPatch, ...stats };
}

function fileLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function hunkRange(start: number, count: number): string {
  return count === 0 ? "0,0" : `${start},${count}`;
}

function unifiedFilePatch(
  oldPath: string,
  newPath: string,
  oldContent: string | null,
  newContent: string | null,
): string {
  const oldLines = fileLines(oldContent ?? "");
  const newLines = fileLines(newContent ?? "");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.min(3, prefix);
  const contextAfter = Math.min(3, suffix);
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const before = oldLines.slice(prefix - contextBefore, prefix);
  const after = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + contextAfter);
  const oldCount = contextBefore + oldChanged.length + contextAfter;
  const newCount = contextBefore + newChanged.length + contextAfter;
  const oldStart = oldContent === null ? 0 : prefix - contextBefore + 1;
  const newStart = newContent === null ? 0 : prefix - contextBefore + 1;
  const displayOld = oldContent === null ? "/dev/null" : `a/${oldPath}`;
  const displayNew = newContent === null ? "/dev/null" : `b/${newPath}`;

  return [
    `diff --git a/${oldPath} b/${newPath}`,
    oldContent === null ? "new file mode 100644" : undefined,
    newContent === null ? "deleted file mode 100644" : undefined,
    `--- ${displayOld}`,
    `+++ ${displayNew}`,
    `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`,
    ...before.map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function countPatchStats(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}
