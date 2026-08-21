import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const SNAPSHOT_PREFIX = "devspace-heap-";
const SNAPSHOT_SUFFIX = ".heapsnapshot";

export interface HeapSnapshotGuardOptions {
  stateDir: string;
  thresholdBytes: number;
  intervalMs?: number;
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, "rss">;
  now?: () => Date;
  writeSnapshot?: (filename: string) => string;
  onError?: (error: unknown) => void;
}

export interface HeapSnapshotGuard {
  checkNow(): string | undefined;
  stop(): void;
}

export function startHeapSnapshotGuard(
  options: HeapSnapshotGuardOptions,
): HeapSnapshotGuard {
  const thresholdBytes = positiveInteger(options.thresholdBytes, "thresholdBytes");
  const intervalMs = positiveInteger(
    options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    "intervalMs",
  );
  const diagnosticsDir = join(options.stateDir, "diagnostics");
  const memoryUsage = options.memoryUsage ?? process.memoryUsage;
  const now = options.now ?? (() => new Date());
  const writeSnapshot = options.writeSnapshot ?? writeHeapSnapshot;
  let captured = hasExistingSnapshot(diagnosticsDir);
  let timer: NodeJS.Timeout | undefined;

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  const checkNow = (): string | undefined => {
    if (captured || memoryUsage().rss < thresholdBytes) return undefined;

    try {
      mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
      chmodSync(diagnosticsDir, 0o700);
      const timestamp = now().toISOString().replaceAll(":", "-");
      const filename = join(
        diagnosticsDir,
        `${SNAPSHOT_PREFIX}${timestamp}-${process.pid}${SNAPSHOT_SUFFIX}`,
      );
      const writtenPath = writeSnapshot(filename);
      chmodSync(writtenPath, 0o600);
      captured = true;
      stop();
      return writtenPath;
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  };

  checkNow();
  if (!captured) {
    timer = setInterval(checkNow, intervalMs);
    timer.unref();
  }

  return { checkNow, stop };
}

function hasExistingSnapshot(diagnosticsDir: string): boolean {
  if (!existsSync(diagnosticsDir)) return false;
  return readdirSync(diagnosticsDir).some(
    (name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
