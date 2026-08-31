import { statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the sibling CLI module used by detached workflow workers. */
export function resolveCliEntry(moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const candidate = join(dirname(modulePath), `cli${extname(modulePath)}`);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // Report the stable candidate below.
  }
  throw new Error(`DevSpace CLI entry does not exist: ${candidate}`);
}
