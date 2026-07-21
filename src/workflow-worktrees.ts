import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CreateAgentWorktree, WorkflowWorktreeHandle } from "./workflow-api.js";
import { WorkflowEngineError } from "./workflow-api.js";

const execFileAsync = promisify(execFile);

export interface WorkflowWorktreeHost {
  worktreeRoot: string;
  /** When set, assert worktree paths stay under this root. */
  allowedRoots?: string[];
}

/**
 * Create a CreateAgentWorktree bound to host config.
 * Layout: `<worktreeRoot>/wf/<runId>/c<callIndex>/`
 */
export function createWorkflowWorktreeFactory(
  host: WorkflowWorktreeHost,
): CreateAgentWorktree {
  return async (input) => {
    const path = join(host.worktreeRoot, "wf", input.runId, `c${input.callIndex}`);
    await mkdir(join(host.worktreeRoot, "wf", input.runId), { recursive: true });

    let sourceRoot: string;
    try {
      sourceRoot = (
        await git(["rev-parse", "--show-toplevel"], input.workspaceRoot)
      ).trim();
    } catch (error) {
      if (isGitUnavailable(error)) {
        throw new WorkflowEngineError(
          "worktree",
          "isolation: 'worktree' requires Git on PATH",
        );
      }
      throw new WorkflowEngineError(
        "worktree",
        `isolation: 'worktree' requires a Git repository (not found at ${input.workspaceRoot})`,
      );
    }

    const baseSha =
      input.baseSha ??
      (await git(["rev-parse", "--verify", "HEAD^{commit}"], sourceRoot)).trim();

    try {
      await git(["worktree", "add", "--detach", path, baseSha], sourceRoot);
    } catch (error) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowEngineError(
        "worktree",
        `Failed to create agent worktree: ${message}`,
      );
    }

    return createHandle({ path, sourceRoot });
  };
}

function createHandle(input: {
  path: string;
  sourceRoot: string;
}): WorkflowWorktreeHandle {
  return {
    path: input.path,
    finalize: async (outcome) => {
      const dirty = await isDirty(input.path);
      if (outcome === "success" && !dirty) {
        await removeWorktree(input.sourceRoot, input.path);
        return { dirty: false, removed: true };
      }
      // Preserve dirty or failed worktrees for diagnosis.
      return { dirty, removed: false };
    },
  };
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  try {
    const status = (await git(["status", "--porcelain=v1"], worktreePath)).trim();
    return status.length > 0;
  } catch {
    // If status fails, treat as dirty so we don't delete.
    return true;
  }
}

export async function removeWorktree(
  sourceRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], sourceRoot);
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    try {
      await git(["worktree", "prune"], sourceRoot);
    } catch {
      // ignore
    }
  }
}

export async function resolveWorkspaceHead(workspaceRoot: string): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--verify", "HEAD^{commit}"], workspaceRoot)).trim();
  } catch {
    return undefined;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;
    const stderr =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const stdout =
      typeof error === "object" && error && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "").trim()
        : "";
    const details =
      stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
