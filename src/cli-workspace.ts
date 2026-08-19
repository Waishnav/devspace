import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface WorkspaceScopedRecord {
  workspaceId?: string;
  workspaceRoot: string;
}

/** Resolve a stable project scope for CLI commands launched inside or outside DevSpace. */
export function resolveCliWorkspaceContext(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CliWorkspaceContext {
  const injectedRoot = env.DEVSPACE_WORKSPACE_ROOT?.trim();
  const gitRoot = injectedRoot ? undefined : findGitRoot(cwd);
  return {
    workspaceId: env.DEVSPACE_WORKSPACE_ID?.trim() || undefined,
    workspaceRoot: injectedRoot
      ? resolve(injectedRoot)
      : findDevspaceProjectRoot(cwd, env, gitRoot) ?? gitRoot ?? resolve(cwd),
  };
}

export function isRecordInCliWorkspace(
  record: WorkspaceScopedRecord,
  context: CliWorkspaceContext,
): boolean {
  if (context.workspaceId) return record.workspaceId === context.workspaceId;
  return resolve(record.workspaceRoot) === context.workspaceRoot;
}

export function assertRecordInCliWorkspace(
  record: WorkspaceScopedRecord,
  context: CliWorkspaceContext,
  label: string,
): void {
  if (!isRecordInCliWorkspace(record, context)) {
    throw new Error(`${label} does not belong to the current project.`);
  }
}

function findDevspaceProjectRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
  gitRoot?: string,
): string | undefined {
  const configDir = resolve(env.DEVSPACE_CONFIG_DIR ?? resolve(homedir(), ".devspace"));
  let current = resolve(cwd);
  for (;;) {
    const marker = resolve(current, ".devspace");
    if (
      marker !== configDir &&
      existsSync(marker) &&
      statSync(marker).isDirectory()
    ) {
      return current;
    }
    if (gitRoot && current === gitRoot) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}
