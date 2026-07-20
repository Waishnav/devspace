/**
 * Context ignore paths — PR #76.
 *
 * Validates and normalizes a list of directory names to skip during
 * nested AGENTS.md / CLAUDE.md discovery.
 *
 * Rules:
 *  - Only workspace-relative directory names are allowed (e.g. "node_modules", "dist").
 *  - Absolute paths are rejected.
 *  - Drive-letter paths (C:\, D:\) are rejected.
 *  - Parent traversal (..) is rejected.
 *  - Empty strings and NULL bytes are rejected.
 *  - Forward/back slashes are normalized.
 *  - Duplicates are removed.
 *  - This only affects nested context file discovery; read, shell, grep still work.
 *  - Pruning happens before entering a directory, not after scanning.
 */

const NULL_BYTE = "\0";

export interface ContextIgnoreResult {
  paths: string[];
  rejected: Array<{ input: string; reason: string }>;
}

/**
 * Parse ignore paths from a comma-separated env string.
 */
export function parseContextIgnoreEnv(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate and normalize a list of ignore paths.
 * Returns accepted paths and a list of rejected entries with reasons.
 */
export function validateContextIgnorePaths(inputs: string[]): ContextIgnoreResult {
  const accepted = new Set<string>();
  const rejected: Array<{ input: string; reason: string }> = [];

  for (const raw of inputs) {
    const input = String(raw ?? "").trim();

    if (input === "") {
      rejected.push({ input: String(raw), reason: "empty path" });
      continue;
    }

    if (input.includes(NULL_BYTE)) {
      rejected.push({ input, reason: "contains NULL byte" });
      continue;
    }

    // Reject absolute paths (Unix and Windows)
    if (input.startsWith("/") || input.startsWith("\\")) {
      rejected.push({ input, reason: "absolute path not allowed" });
      continue;
    }

    // Reject drive-letter paths (C:\, D:\, etc.)
    if (/^[a-zA-Z]:[\\/]/.test(input)) {
      rejected.push({ input, reason: "drive-letter path not allowed" });
      continue;
    }

    // Reject parent traversal
    if (input === ".." || input.startsWith("../") || input.startsWith("..\\") ||
        input.includes("/../") || input.includes("\\..\\")) {
      rejected.push({ input, reason: "parent traversal (..) not allowed" });
      continue;
    }

    // Normalize slashes: strip leading/trailing slashes, normalize to forward
    let normalized = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

    // Re-check after normalization
    if (normalized === ".." || normalized.startsWith("../")) {
      rejected.push({ input, reason: "parent traversal (..) after normalization" });
      continue;
    }

    if (normalized === "") {
      rejected.push({ input, reason: "empty after normalization" });
      continue;
    }

    accepted.add(normalized);
  }

  return {
    paths: [...accepted].sort(),
    rejected,
  };
}

/**
 * Resolve final ignore paths from env and config.
 * Env takes precedence (comma-separated), then config.json array.
 */
export function resolveContextIgnorePaths(
  envValue: string | undefined,
  configValue: string[] | undefined,
): string[] {
  const envPaths = parseContextIgnoreEnv(envValue);
  const source = envPaths.length > 0 ? envPaths : (configValue ?? []);
  const result = validateContextIgnorePaths(source);
  return result.paths;
}

/**
 * Check if a directory entry name should be skipped during context file discovery.
 * Uses the pre-validated ignore set for O(1) lookup.
 */
export function shouldSkipForContext(
  dirName: string,
  ignorePaths: Set<string>,
  defaultSkipped: Set<string>,
): boolean {
  if (defaultSkipped.has(dirName)) return true;
  if (ignorePaths.has(dirName)) return true;
  // Also check normalized (forward-slash) form
  const normalized = dirName.replace(/\\/g, "/");
  if (ignorePaths.has(normalized)) return true;
  return false;
}

/**
 * Default candidate paths to check for existence before adding to ignore list.
 * Only paths that actually exist AND are confirmed to not hold project rule files
 * should be added to the final config.
 */
export const DEFAULT_IGNORE_CANDIDATES = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  "target",
  "vendor",
  "tmp",
  "temp",
];

/**
 * Paths that must NEVER be ignored (they may hold AGENTS.md or project rules).
 */
export const NEVER_IGNORE = new Set([
  "src",
  "docs",
  "tests",
  "test",
  "scripts",
  ".github",
  ".devspace",
  ".",
  "",
]);
