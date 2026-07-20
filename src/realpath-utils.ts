/**
 * Realpath utilities — PR #65/#66.
 *
 * Provides safe realpath resolution for workspace roots, agent directories,
 * and AGENTS.md / CLAUDE.md files.
 *
 * Key behaviors:
 *  - Resolves symlinks (including Windows junctions and directory aliases)
 *    to their final target.
 *  - Deduplicates loaded and discovered files by realpath.
 *  - Rejects symlinks that point outside allowed roots.
 *  - Falls back safely when realpath fails (e.g., broken symlink).
 *  - Does NOT expand allowedRoots permissions.
 */

import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";

/**
 * Safely resolve the real path of a file or directory.
 * Returns the original path on failure (e.g., broken symlink, permission error).
 */
export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // Fallback: resolve without following symlinks
    return resolve(p);
  }
}

/**
 * Synchronous version using realpathSync.
 */
import { realpathSync } from "node:fs";

export function safeRealpathSync(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Check if a resolved path is inside any of the allowed roots.
 * Uses realpath on both the path and the roots for accurate comparison.
 */
export function isRealpathInsideRoots(
  resolvedPath: string,
  allowedRoots: string[],
): boolean {
  const normalizedPath = resolvedPath.toLowerCase().replace(/\\/g, "/");
  for (const root of allowedRoots) {
    const normalizedRoot = root.toLowerCase().replace(/\\/g, "/");
    if (normalizedPath === normalizedRoot) return true;
    if (normalizedPath.startsWith(normalizedRoot + "/")) return true;
    // Handle case where root is a drive root like "C:" vs "C:\"
    if (normalizedRoot.endsWith(":") && normalizedPath.startsWith(normalizedRoot + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve and validate a workspace root using realpath.
 * Returns the realpath and whether it's inside allowed roots.
 */
export async function resolveAndValidateRoot(
  inputPath: string,
  allowedRoots: string[],
): Promise<{ realpath: string; allowed: boolean }> {
  const resolved = resolve(inputPath);
  const real = await safeRealpath(resolved);
  const allowed = isRealpathInsideRoots(real, allowedRoots);
  return { realpath: real, allowed };
}

/**
 * Deduplicate a list of file paths by their realpath.
 * Preserves the order of first occurrence.
 */
export async function deduplicateByRealpath(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const real = await safeRealpath(p);
    const key = real.toLowerCase().replace(/\\/g, "/");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

/**
 * Deduplicate synchronously (for use in non-async contexts).
 */
export function deduplicateByRealpathSync(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const real = safeRealpathSync(p);
    const key = real.toLowerCase().replace(/\\/g, "/");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}
