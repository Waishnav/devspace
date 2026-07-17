import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { WorkflowStore, WorkflowValidationError } from "./store.js";
import type { WorkflowAttemptIdentity, WorkflowWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const FAILED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export async function allocateWorkflowWorktree(input: {
  store: WorkflowStore;
  identity: WorkflowAttemptIdentity;
  sourceRoot: string;
  worktreeRoot: string;
  baseSha: string;
}): Promise<WorkflowWorktreeRecord> {
  const existing = input.store.getWorktree(
    input.identity.workflowId,
    input.identity.nodeKey,
    input.identity.attempt,
  );
  if (existing) {
    if (existing.state === "active") return existing;
    throw new WorkflowValidationError(
      `Workflow worktree attempt already has allocation state ${existing.state}`,
    );
  }

  const sourceRoot = await canonicalDirectory(input.sourceRoot, "workflow source root");
  await mkdir(input.worktreeRoot, { recursive: true });
  const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "workflow worktree root");
  const gitRoot = await git(["rev-parse", "--show-toplevel"], sourceRoot);
  if ((await realpath(gitRoot.trim())) !== sourceRoot) {
    throw new WorkflowValidationError("Workflow workspace_write source must be a Git repository root");
  }
  const baseSha = (await git(["rev-parse", "--verify", `${input.baseSha}^{commit}`], sourceRoot)).trim();
  if (baseSha !== input.baseSha) {
    throw new WorkflowValidationError("Workflow worktree base SHA no longer resolves to the pinned commit");
  }

  const path = join(
    worktreeRoot,
    `${safeSegment(basename(sourceRoot))}-${safeSegment(input.identity.workflowId)}-${safeSegment(input.identity.nodeKey)}-a${input.identity.attempt}`,
  );
  assertContained(path, worktreeRoot);
  const record = input.store.recordWorktree({
    workflowId: input.identity.workflowId,
    nodeKey: input.identity.nodeKey,
    attempt: input.identity.attempt,
    path,
    sourceRoot,
    baseSha,
    retainUntil: new Date(Date.now() + FAILED_WORKTREE_RETENTION_MS).toISOString(),
  });
  try {
    await git(["worktree", "add", "--detach", path, baseSha], sourceRoot);
    return input.store.updateWorktreeState(
      record.workflowId,
      record.nodeKey,
      record.attempt,
      "active",
    );
  } catch (error) {
    input.store.updateWorktreeState(
      record.workflowId,
      record.nodeKey,
      record.attempt,
      "cleanup_failed",
      error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
    );
    throw error;
  }
}

export function preserveWorkflowWorktree(
  store: WorkflowStore,
  identity: WorkflowAttemptIdentity,
): WorkflowWorktreeRecord | undefined {
  const record = store.getWorktree(identity.workflowId, identity.nodeKey, identity.attempt);
  if (!record || record.state === "removed") return record;
  return store.updateWorktreeState(identity.workflowId, identity.nodeKey, identity.attempt, "preserved");
}

export async function cleanupExpiredWorkflowWorktrees(input: {
  store: WorkflowStore;
  now?: string;
  beforeCleanup?: () => boolean;
}): Promise<number> {
  let removed = 0;
  for (const record of input.store.listExpiredWorktrees(input.now)) {
    if (input.beforeCleanup && !input.beforeCleanup()) break;
    try {
      await cleanupWorkflowWorktree({
        store: input.store,
        identity: {
          workflowId: record.workflowId,
          nodeKey: record.nodeKey,
          attempt: record.attempt,
          claimToken: "retention-cleanup",
        },
        worktreeRoot: dirname(record.path),
      });
      removed += 1;
    } catch {
      // cleanupWorkflowWorktree persists the failure for a later retry.
    }
  }
  return removed;
}

export async function cleanupWorkflowWorktree(input: {
  store: WorkflowStore;
  identity: WorkflowAttemptIdentity;
  worktreeRoot: string;
}): Promise<WorkflowWorktreeRecord | undefined> {
  const record = input.store.getWorktree(
    input.identity.workflowId,
    input.identity.nodeKey,
    input.identity.attempt,
  );
  if (!record || record.state === "removed") return record;

  try {
    const expectedName = `${safeSegment(basename(record.sourceRoot))}-${safeSegment(record.workflowId)}-${safeSegment(record.nodeKey)}-a${record.attempt}`;
    if (basename(record.path) !== expectedName) {
      throw new WorkflowValidationError("Workflow worktree path does not match persisted ownership");
    }
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "workflow worktree root");
    assertContained(record.path, worktreeRoot);
    const canonicalWorktreePath = await canonicalDirectory(record.path, "workflow worktree path");
    assertContained(canonicalWorktreePath, worktreeRoot);
    const registered = await registeredWorktrees(record.sourceRoot);
    const match = registered.find((entry) => resolve(entry.path) === resolve(record.path));
    if (!match) {
      throw new WorkflowValidationError("Workflow worktree Git registration does not match persisted ownership");
    }
    await git(["merge-base", "--is-ancestor", record.baseSha, match.head], record.sourceRoot);
    await git(["worktree", "remove", "--force", record.path], record.sourceRoot);
    return input.store.updateWorktreeState(
      record.workflowId,
      record.nodeKey,
      record.attempt,
      "removed",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.store.updateWorktreeState(
      record.workflowId,
      record.nodeKey,
      record.attempt,
      "cleanup_failed",
      message.slice(0, 4_096),
    );
    throw error;
  }
}

async function registeredWorktrees(sourceRoot: string): Promise<Array<{ path: string; head: string }>> {
  const output = await git(["worktree", "list", "--porcelain"], sourceRoot);
  const records: Array<{ path: string; head: string }> = [];
  let path: string | undefined;
  let head: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
    else if (!line && path && head) {
      records.push({ path, head });
      path = undefined;
      head = undefined;
    }
  }
  if (path && head) records.push({ path, head });
  return records;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new WorkflowValidationError(`Invalid ${label}: ${path}`);
  }
}

function assertContained(path: string, root: string): void {
  const relationship = relative(root, resolve(path));
  if (relationship === "" || relationship === ".." || relationship.startsWith("../") || relationship.startsWith("..\\")) {
    throw new WorkflowValidationError("Workflow worktree path escapes the managed root");
  }
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  if (!segment) throw new WorkflowValidationError("Workflow worktree identity is invalid");
  return segment;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    throw new WorkflowValidationError(stderr || (error instanceof Error ? error.message : String(error)));
  }
}
