import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

export function removeDevspaceNodeModulesBinFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !isDevspaceNodeModulesBin(entry))
    .join(delimiter);
}

function isDevspaceNodeModulesBin(pathEntry: string): boolean {
  const resolvedEntry = resolve(pathEntry);
  if (!resolvedEntry.endsWith(`${sep}node_modules${sep}.bin`)) {
    return false;
  }

  const packageJson = resolve(resolvedEntry, "..", "..", "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const packageInfo = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    return packageInfo.name === "@waishnav/devspace";
  } catch {
    return false;
  }
}
