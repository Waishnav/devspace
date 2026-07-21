import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Result, type Result as BetterResult } from "better-result";
import type { CreateAgentWorktree, WorkflowWorktreeHandle } from "./workflow-api.js";
import { WorktreeOperationError } from "./workflow-errors.js";

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
    const result = await createWorkflowWorktreeResult(host, input);
    if (result.isErr()) throw result.error;
    return result.value;
  };
}

export async function createWorkflowWorktreeResult(
  host: WorkflowWorktreeHost,
  input: Parameters<CreateAgentWorktree>[0],
): Promise<BetterResult<WorkflowWorktreeHandle, WorktreeOperationError>> {
  return Result.tryPromise({
    try: async () => {
      const path = join(host.worktreeRoot, "wf", input.runId, `c${input.callIndex}`);
      await mkdir(join(host.worktreeRoot, "wf", input.runId), { recursive: true });

      let sourceRoot: string;
      try {
        sourceRoot = (
          await git(["rev-parse", "--show-toplevel"], input.workspaceRoot)
        ).trim();
      } catch (error) {
        if (isGitUnavailable(error)) {
          throw new Error("isolation: 'worktree' requires Git on PATH", { cause: error });
        }
        throw new Error(
          `isolation: 'worktree' requires a Git repository (not found at ${input.workspaceRoot})`,
          { cause: error },
        );
      }

      const baseSha =
        input.baseSha ??
        (await git(["rev-parse", "--verify", "HEAD^{commit}"], sourceRoot)).trim();

      try {
        await git(["worktree", "add", "--detach", path, baseSha], sourceRoot);
      } catch (error) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Failed to create and clean up agent worktree",
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create agent worktree: ${message}`, { cause: error });
      }

      return createHandle({ path, sourceRoot });
    },
    catch: (cause) =>
      new WorktreeOperationError({
        operation: "create",
        runId: input.runId,
        callIndex: input.callIndex,
        cause,
      }),
  });
}

function createHandle(input: {
  path: string;
  sourceRoot: string;
}): WorkflowWorktreeHandle {
  return {
    path: input.path,
    finalize: async (outcome) => {
      const dirtyResult = await isDirtyResult(input.path);
      if (dirtyResult.isErr()) throw dirtyResult.error;
      const dirty = dirtyResult.value;
      if (outcome === "success" && !dirty) {
        const removed = await removeWorktreeResult(input.sourceRoot, input.path);
        if (removed.isErr()) throw removed.error;
        return { dirty: false, removed: true };
      }
      // Preserve dirty or failed worktrees for diagnosis.
      return { dirty, removed: false };
    },
  };
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  const result = await isDirtyResult(worktreePath);
  return result.isOk() ? result.value : true;
}

export async function isDirtyResult(
  worktreePath: string,
): Promise<BetterResult<boolean, WorktreeOperationError>> {
  return Result.tryPromise({
    try: async () => {
      const status = (await git(["status", "--porcelain=v1"], worktreePath)).trim();
      return status.length > 0;
    },
    catch: (cause) =>
      new WorktreeOperationError({
        operation: "inspect",
        path: worktreePath,
        cause,
      }),
  });
}

export async function removeWorktree(
  sourceRoot: string,
  worktreePath: string,
): Promise<void> {
  const result = await removeWorktreeResult(sourceRoot, worktreePath);
  if (result.isErr()) throw result.error;
}

export async function removeWorktreeResult(
  sourceRoot: string,
  worktreePath: string,
): Promise<BetterResult<void, WorktreeOperationError>> {
  return Result.tryPromise({
    try: async () => {
      try {
        await git(["worktree", "remove", "--force", worktreePath], sourceRoot);
      } catch (removeError) {
        await rm(worktreePath, { recursive: true, force: true });
        try {
          await git(["worktree", "prune"], sourceRoot);
        } catch (pruneError) {
          throw new AggregateError(
            [removeError, pruneError],
            "Worktree directory was removed but Git metadata pruning failed",
          );
        }
      }
    },
    catch: (cause) =>
      new WorktreeOperationError({
        operation: "remove",
        path: worktreePath,
        cause,
      }),
  });
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
