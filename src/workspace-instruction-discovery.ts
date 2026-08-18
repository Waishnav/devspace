import { spawn } from "node:child_process";
import { opendir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { isPathInsideRoot } from "./roots.js";

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
] as const;
const SKIPPED_CONTEXT_DIR_SET = new Set<string>(SKIPPED_CONTEXT_DIRS);
const NODE_DIRECTORY_CONCURRENCY = 8;

export type InstructionPathFinder = "fd" | "node";
export type IncompleteInstructionDiscoveryReason =
  | "deadline_exceeded"
  | "result_limit_exceeded";

export type InstructionPathDiscoveryResult =
  | {
      status: "complete";
      finder: InstructionPathFinder;
      paths: string[];
    }
  | {
      status: "incomplete";
      finder: InstructionPathFinder;
      reason: IncompleteInstructionDiscoveryReason;
      paths: [];
    };

interface InstructionDiscoveryLimits {
  maxFiles?: number;
  maxPathBytes?: number;
  maxDurationMs?: number;
}

interface DiscoverInstructionPathsOptions {
  excludedPaths?: ReadonlySet<string>;
  finder?: "auto" | "node";
  limits?: InstructionDiscoveryLimits;
}

type FdDiscoveryResult = InstructionPathDiscoveryResult | { status: "unavailable" };

interface CandidateAccumulator {
  add(path: string): IncompleteInstructionDiscoveryReason | undefined;
  complete(finder: InstructionPathFinder): InstructionPathDiscoveryResult;
}

export async function discoverInstructionPaths(
  root: string,
  options: DiscoverInstructionPathsOptions = {},
): Promise<InstructionPathDiscoveryResult> {
  const resolvedRoot = resolve(root);
  const deadline = options.limits?.maxDurationMs === undefined
    ? Number.POSITIVE_INFINITY
    : performance.now() + options.limits.maxDurationMs;

  if (options.finder !== "node") {
    const fdResult = await discoverWithFd(resolvedRoot, options, deadline);
    if (fdResult.status !== "unavailable") return fdResult;
  }

  return discoverWithNode(resolvedRoot, options, deadline);
}

async function discoverWithFd(
  root: string,
  options: DiscoverInstructionPathsOptions,
  deadline: number,
): Promise<FdDiscoveryResult> {
  const accumulator = createCandidateAccumulator(root, options);
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    return incomplete("fd", "deadline_exceeded");
  }

  const args = [
    "--hidden",
    "--no-ignore",
    "--type",
    "f",
    "--case-sensitive",
    "--absolute-path",
    "--print0",
    ...SKIPPED_CONTEXT_DIRS.flatMap((directory) => ["--exclude", directory]),
    "^(AGENTS\\.md|AGENTS\\.MD|CLAUDE\\.md|CLAUDE\\.MD)$",
    ".",
  ];

  return new Promise((resolveResult) => {
    const child = spawn("fd", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    let output = "";
    let stopReason: IncompleteInstructionDiscoveryReason | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: FdDiscoveryResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const stop = (reason: IncompleteInstructionDiscoveryReason): void => {
      if (stopReason) return;
      stopReason = reason;
      child.stdout.destroy();
      child.kill();
      child.unref();
      finish(incomplete("fd", reason));
    };
    const processOutput = (): void => {
      while (!stopReason) {
        const separator = output.indexOf("\0");
        if (separator === -1) return;
        const path = output.slice(0, separator);
        output = output.slice(separator + 1);
        const reason = accumulator.add(path);
        if (reason) stop(reason);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopReason) return;
      output += chunk;
      processOutput();
    });
    child.on("error", () => finish({ status: "unavailable" }));
    child.on("close", (code) => {
      if (stopReason) {
        finish(incomplete("fd", stopReason));
        return;
      }
      if (code !== 0) {
        finish({ status: "unavailable" });
        return;
      }
      if (performance.now() >= deadline) {
        finish(incomplete("fd", "deadline_exceeded"));
        return;
      }

      processOutput();
      finish(accumulator.complete("fd"));
    });

    timer = Number.isFinite(remainingMs)
      ? setTimeout(() => stop("deadline_exceeded"), remainingMs)
      : undefined;
    timer?.unref();
  });
}

async function discoverWithNode(
  root: string,
  options: DiscoverInstructionPathsOptions,
  deadline: number,
): Promise<InstructionPathDiscoveryResult> {
  const accumulator = createCandidateAccumulator(root, options);
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    return incomplete("node", "deadline_exceeded");
  }

  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const traversal = traverseWithNode(root, accumulator, deadline, () => cancelled);
  if (!Number.isFinite(remainingMs)) return traversal;

  const deadlineResult = new Promise<InstructionPathDiscoveryResult>((resolveResult) => {
    timer = setTimeout(() => {
      cancelled = true;
      resolveResult(incomplete("node", "deadline_exceeded"));
    }, remainingMs);
    timer.unref();
  });
  const result = await Promise.race([traversal, deadlineResult]);
  if (timer) clearTimeout(timer);
  return result;
}

async function traverseWithNode(
  root: string,
  accumulator: CandidateAccumulator,
  deadline: number,
  isCancelled: () => boolean,
): Promise<InstructionPathDiscoveryResult> {
  let directories = [root];

  while (directories.length > 0) {
    if (isCancelled() || performance.now() >= deadline) {
      return incomplete("node", "deadline_exceeded");
    }

    const currentDirectories = directories;
    const nextDirectories: string[] = [];
    let cursor = 0;
    let stopReason: IncompleteInstructionDiscoveryReason | undefined;

    const worker = async (): Promise<void> => {
      while (!isCancelled() && !stopReason && cursor < currentDirectories.length) {
        const directory = currentDirectories[cursor++];
        let entries;
        try {
          entries = await opendir(directory);
        } catch {
          continue;
        }

        try {
          while (!isCancelled() && !stopReason) {
            const entry = await entries.read();
            if (isCancelled() || stopReason) return;
            if (!entry) break;
            if (performance.now() >= deadline) {
              stopReason = "deadline_exceeded";
              return;
            }

            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) {
              if (!SKIPPED_CONTEXT_DIR_SET.has(entry.name)) nextDirectories.push(path);
              continue;
            }
            if (!entry.isFile() || !CONTEXT_FILE_NAMES.has(entry.name)) continue;

            stopReason = accumulator.add(path);
          }
        } catch {
          // Unreadable directories do not prevent discovery elsewhere in the workspace.
        } finally {
          await entries.close().catch(() => undefined);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(NODE_DIRECTORY_CONCURRENCY, currentDirectories.length) },
        worker,
      ),
    );
    if (stopReason) return incomplete("node", stopReason);
    if (isCancelled() || performance.now() >= deadline) {
      return incomplete("node", "deadline_exceeded");
    }
    directories = nextDirectories;
  }

  return accumulator.complete("node");
}

function createCandidateAccumulator(
  root: string,
  options: DiscoverInstructionPathsOptions,
): CandidateAccumulator {
  const excludedPaths = new Set(
    [...(options.excludedPaths ?? [])].map((path) => resolve(path)),
  );
  const paths = new Set<string>();
  const maxFiles = options.limits?.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxPathBytes = options.limits?.maxPathBytes ?? Number.POSITIVE_INFINITY;
  let pathBytes = 0;

  return {
    add(inputPath) {
      const path = resolve(root, inputPath);
      if (!isPathInsideRoot(path, root)) return undefined;
      if (!CONTEXT_FILE_NAMES.has(basename(path))) return undefined;
      if (excludedPaths.has(path) || paths.has(path)) return undefined;

      const relativePath = relative(root, path);
      const nextPathBytes = Buffer.byteLength(relativePath, "utf8") + 1;
      if (paths.size >= maxFiles || pathBytes + nextPathBytes > maxPathBytes) {
        return "result_limit_exceeded";
      }

      paths.add(path);
      pathBytes += nextPathBytes;
      return undefined;
    },
    complete(finder) {
      return {
        status: "complete",
        finder,
        paths: [...paths].sort((a, b) => a.localeCompare(b)),
      };
    },
  };
}

function incomplete(
  finder: InstructionPathFinder,
  reason: IncompleteInstructionDiscoveryReason,
): InstructionPathDiscoveryResult {
  return { status: "incomplete", finder, reason, paths: [] };
}
