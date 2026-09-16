import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";

export type WorkflowStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkflowWriteMode = "read_only" | "allowed";
export interface WorkflowFailure { code: string; message: string; retryable: boolean }
export class WorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "WorkflowError";
  }
}
export interface WorkflowRunInput extends LocalAgentWorkspaceScope {
  source?: string;
  name?: string;
  args?: unknown;
  resume?: string;
  writeMode?: WorkflowWriteMode;
}
export interface WorkflowRun extends LocalAgentWorkspaceScope {
  id: string;
  name: string;
  status: WorkflowStatus;
  writeMode: WorkflowWriteMode;
  concurrency: number;
  resumeOf?: string;
  result?: unknown;
  error?: WorkflowFailure;
  createdAt: string;
  updatedAt: string;
  callCount: number;
}
export interface WorkflowSnapshot extends WorkflowRun {
  source: string;
  args: unknown;
  contextHash: string;
}
export interface WorkflowAgentOptions {
  target: string;
  model?: string;
  effort?: string;
  schema?: Record<string, unknown>;
  label?: string;
  phase?: string;
  writeMode?: WorkflowWriteMode;
  isolation?: "worktree";
  /** A logical name, shared by calls in this run; never a filesystem path. */
  workspace?: string;
}
export interface WorkflowCall {
  runId: string;
  index: number;
  agentId: string;
  turnId?: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  prompt: string;
  options: WorkflowAgentOptions;
  fingerprint: string;
  workspaceRoot: string;
  workspaceId?: string;
  result?: unknown;
  error?: WorkflowFailure;
  reusedFrom?: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowEvent { sequence: number; runId: string; type: string; data: unknown; createdAt: string }
export function workflowFailure(error: unknown): WorkflowFailure {
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
  return {
    code: typeof value?.code === "string" ? value.code : "WORKFLOW_FAILED",
    message: typeof value?.message === "string" ? value.message : String(error),
    retryable: value?.retryable === true,
  };
}
export function workflowTerminal(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}
