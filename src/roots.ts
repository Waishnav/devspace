import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, expandHomePath(inputPath));
  return assertAllowedPath(absolutePath, allowedRoots);
}

export async function resolveCanonicalAllowedPath(
  inputPath: string,
  cwd: string,
  allowedRoots: string[],
): Promise<string> {
  const absolutePath = resolveAllowedPath(inputPath, cwd, allowedRoots);
  const canonicalPath = await canonicalizePath(absolutePath);

  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(resolve(expandHomePath(root)));
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (isPathInsideRoot(canonicalPath, canonicalRoot)) return canonicalPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${inputPath}`);
}

export async function resolvePathInsideCanonicalRoot(
  inputPath: string,
  cwd: string,
  logicalRoot: string,
  canonicalRoot: string,
): Promise<string> {
  const absolutePath = resolveAllowedPath(inputPath, cwd, [logicalRoot]);
  const canonicalPath = await canonicalizePath(absolutePath);
  if (isPathInsideRoot(canonicalPath, canonicalRoot)) return canonicalPath;
  throw new AccessDeniedError(`Path is outside allowed roots: ${inputPath}`);
}

async function canonicalizePath(path: string): Promise<string> {
  const absolutePath = resolve(expandHomePath(path));
  let candidate = absolutePath;

  for (;;) {
    try {
      const boundaryPath = await realpath(candidate);
      const suffix = relative(candidate, absolutePath);
      return suffix ? resolve(boundaryPath, suffix) : boundaryPath;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;

      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink()) {
          throw new AccessDeniedError(`Cannot resolve symbolic link: ${path}`);
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }

      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR"),
  );
}
