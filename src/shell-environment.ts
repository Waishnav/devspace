import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface ShellPathInfo {
  path: string;
  entries: string[];
  addedEntries: string[];
}

function uniqueEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function shellPathInfo(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  directoryExists: (path: string) => boolean = existsSync,
): ShellPathInfo {
  const existingEntries = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates = platform === "win32"
    ? []
    : [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        join(home, ".local", "bin"),
        join(home, "bin"),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];
  const existingSet = new Set(existingEntries);
  const addedEntries = uniqueEntries(candidates)
    .filter((entry) => !existingSet.has(entry) && directoryExists(entry));
  const entries = uniqueEntries([...existingEntries, ...addedEntries]);

  return {
    path: entries.join(delimiter),
    entries,
    addedEntries,
  };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function commandWithAugmentedPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return command;
  const info = shellPathInfo(env, platform);
  return `export PATH=${quotePosix(info.path)}; ${command}`;
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return undefined;
  const info = shellPathInfo(env, platform);
  const extensions = platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const entry of info.entries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}
