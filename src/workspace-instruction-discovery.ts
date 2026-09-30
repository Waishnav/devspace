import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const SKIPPED_CONTEXT_DIRS = new Set([
  ".git", ".hg", ".svn", ".devspace", "node_modules", "dist", "build",
  ".next", ".turbo", ".cache",
]);

interface DiscoveryLimits {
  maxDirectories: number;
  maxEntries: number;
  maxDurationMs: number;
}

/** Return false when discovery stops early; close directory handles on exit. */
export async function walkWorkspaceInstructions(
  root: string,
  visit: (path: string, name: string) => Promise<void> | void,
  limits: DiscoveryLimits = {
    maxDirectories: 256,
    maxEntries: 10_000,
    maxDurationMs: 1_000,
  },
): Promise<boolean> {
  const deadline = performance.now() + limits.maxDurationMs;
  let directories = 0;
  let entriesVisited = 0;

  async function walk(directory: string): Promise<boolean> {
    if (directories >= limits.maxDirectories || performance.now() >= deadline) return false;
    directories++;
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      // Preserve discovery's existing handling of inaccessible directories.
      return true;
    }

    for await (const entry of entries) {
      if (entriesVisited >= limits.maxEntries || performance.now() >= deadline) return false;
      entriesVisited++;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_CONTEXT_DIRS.has(entry.name) && !await walk(path)) return false;
      } else if (entry.isFile()) {
        await visit(path, entry.name);
      }
    }
    return true;
  }

  return walk(root);
}
