import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { lt } from "semver";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";

export const MINIMUM_CODEX_VERSION = "0.142.5";

export interface ResolvedCodexCommand {
  executable: string;
  version?: string;
}

// Mirror the Pi/Claude adapters: strip DevSpace's own entrypoint markers from
// the child environment and, unless the caller pinned a command, keep DevSpace's
// own `node_modules/.bin` from shadowing the host-installed `codex` on PATH.
export function codexCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (env.CODEX_COMMAND) return next;
  const path = next.PATH;
  if (!path) return next;
  return {
    ...next,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodexCommand | undefined {
  const probeEnv = codexCommandEnvironment(env);
  const command = env.CODEX_COMMAND ?? "codex";
  for (const candidate of codexCommandCandidates(command, probeEnv)) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: probeEnv,
      windowsHide: true,
      timeout: 5_000,
    });
    const spawnCode =
      probe.error && "code" in probe.error ? probe.error.code : undefined;
    if (spawnCode === "ENOENT") continue;
    return {
      executable: candidate,
      version: parseCodexVersion(probe.stdout),
    };
  }
  return undefined;
}

export function isCodexVersionAtLeastFloor(version: string): boolean {
  return !lt(version, MINIMUM_CODEX_VERSION);
}

export function parseCodexVersion(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = output
    .trim()
    .match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  const version = match?.[1];
  return version ?? undefined;
}

function codexCommandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const hasPath = command.includes("/") || command.includes("\\");
  if (hasPath) return [command];
  const pathValue = env.PATH;
  if (!pathValue) return [command];
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      candidates.push(resolve(directory, `${command}${extension}`));
    }
  }
  return candidates;
}