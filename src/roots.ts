import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safeRealpathSync, isRealpathInsideRoots } from "./realpath-utils.js";

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
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

/**
 * Realpath-aware path validation 鈥?PR #65/#66.
 * Resolves symlinks (including Windows junctions) before checking allowed roots.
 * Does NOT expand allowedRoots 鈥?if a symlink points outside, it is rejected.
 */
export function assertAllowedPathRealpath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  const realPath = safeRealpathSync(resolvedPath);
  if (allowedRoots.some((root) => {
    const realRoot = safeRealpathSync(resolve(expandHomePath(root)));
    return isRealpathInsideRoots(realPath, [realRoot]);
  })) {
    return realPath;
  }
  // Fallback to non-realpath check (in case realpath fails but path is valid)
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }
  throw new AccessDeniedError(`Path is outside allowed roots (realpath check): ${path}`);
}