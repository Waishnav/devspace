/**
 * Frozen contracts for DevSpace Dynamic Workflows.
 * Engine modules must import these rather than invent parallel shapes.
 *
 * Locks:
 * - No writeMode on AgentOpts (prompt RO/write + isolation containment).
 * - budget is a stub shape in v1.
 * - nest depth 1; max pipeline/parallel items 4096.
 * - concurrency default min(16, max(1, availableParallelism()-2)).
 */

import type { LocalAgentProvider } from "./local-agent-profiles.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const WORKFLOW_MAX_ITEMS = 4096;
export const WORKFLOW_MAX_NEST_DEPTH = 1;
export const WORKFLOW_MAX_SCHEMA_RETRIES = 2;
export const WORKFLOW_HEARTBEAT_MS = 5_000;
export const WORKFLOW_CANCEL_HARD_MS = 5_000;
export const WORKFLOW_HOST_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const WORKFLOW_MCP_YIELD_MS = 110_000;

/** Soft/hard transport + storage caps (not semantic coverage truncation). */
export const WORKFLOW_LIMITS = {
  eventDataJsonBytes: 8 * 1024,
  responseTextBytes: 1 * 1024 * 1024,
  structuredJsonBytes: 256 * 1024,
  resultJsonBytes: 256 * 1024,
  argsJsonBytes: 64 * 1024,
  scriptSourceBytes: 512 * 1024,
  eventDrainDefault: 200,
  eventDrainMax: 500,
} as const;

// ---------------------------------------------------------------------------
// Provider config (user config / ServerConfig)
// ---------------------------------------------------------------------------

export type AgentProviderId = LocalAgentProvider;

export interface AgentProviderProbe {
  id: AgentProviderId;
  available: boolean;
  detail?: string;
}

/**
 * Ordered enable-list. index 0 = default fallback after live availability filter.
 * Missing block on disk → compat all-available in product order.
 * Explicit enabled: [] → no providers; first agent() fails.
 */
export interface AgentProvidersConfig {
  enabled: AgentProviderId[];
  detectedAt?: string;
  lastProbe?: AgentProviderProbe[];
}

// ---------------------------------------------------------------------------
// Script meta + agent opts
// ---------------------------------------------------------------------------

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowPhaseMeta[];
  whenToUse?: string;
  /** DevSpace extension */
  defaultProvider?: AgentProviderId;
  /** DevSpace extension; clamped to engine max */
  concurrency?: number;
}

/**
 * Public agent() options. Deliberately no writeMode.
 */
export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: object;
  model?: string;
  /** Provider-native effort/reasoning level (was thinking). */
  effort?: string;
  provider?: AgentProviderId | string;
  isolation?: "worktree";
}

export type AgentIsolationMode = "shared" | "worktree";

// ---------------------------------------------------------------------------
// Status / events
// ---------------------------------------------------------------------------

export type WorkflowRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowAgentCallStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "from_cache";

export type WorkflowEventType =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "phase_started"
  | "log"
  | "agent_call_started"
  | "agent_call_completed"
  | "agent_call_failed"
  | "agent_call_cached"
  | "schema_retry"
  | "worktree_created"
  | "worktree_finalized";

export type WorkflowErrorKind =
  | "syntax"
  | "meta"
  | "determinism"
  | "provider_disabled"
  | "provider_unavailable"
  | "no_provider"
  | "provider"
  | "schema"
  | "cancelled"
  | "timeout"
  | "heartbeat"
  | "worktree"
  | "nest_depth"
  | "path"
  | "result_too_large"
  | "args_too_large"
  | "script_too_large"
  | "internal";

// ---------------------------------------------------------------------------
// Journal row shapes (behavioral; store maps snake_case)
// ---------------------------------------------------------------------------

export type WorkflowRunSource = "inline" | "named" | "resume";

export interface WorkflowRunRecord {
  id: string;
  name: string;
  source: WorkflowRunSource;
  scriptPath: string;
  scriptHash: string;
  workspaceRoot: string;
  workspaceId?: string;
  argsJson: string;
  status: WorkflowRunStatus;
  error?: string;
  errorKind?: WorkflowErrorKind;
  resultJson?: string;
  pid?: number;
  heartbeatAt?: string;
  cancelRequested: boolean;
  resumedFromRunId?: string;
  /** Pinned at run start for isolation: worktree reproducibility. */
  baseSha?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface WorkflowEventRecord {
  runId: string;
  seq: number;
  type: WorkflowEventType;
  phase?: string;
  label?: string;
  dataJson: string;
  createdAt: string;
}

export interface WorkflowAgentCallRecord {
  runId: string;
  callIndex: number;
  cacheKey: string;
  provider: string;
  model?: string;
  effort?: string;
  label?: string;
  phase?: string;
  status: WorkflowAgentCallStatus;
  fromCache: boolean;
  providerSessionId?: string;
  responseText?: string;
  structuredJson?: string;
  error?: string;
  isolation: AgentIsolationMode;
  worktreePath?: string;
  dirty?: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Canonical fields for agent() resume identity.
 * Field order for JSON serialization is fixed by buildAgentCacheKeyInput.
 */
export interface AgentCacheKeyInput {
  prompt: string;
  provider: string;
  model: string | null;
  effort: string | null;
  schema: object | null;
  isolation: AgentIsolationMode;
}

export function buildAgentCacheKeyInput(input: {
  prompt: string;
  provider: string;
  model?: string | null;
  effort?: string | null;
  schema?: object | null;
  isolation?: AgentIsolationMode | "worktree" | null;
}): AgentCacheKeyInput {
  const isolation: AgentIsolationMode =
    input.isolation === "worktree" ? "worktree" : "shared";
  return {
    prompt: input.prompt,
    provider: input.provider,
    model: input.model ?? null,
    effort: input.effort ?? null,
    schema: input.schema ?? null,
    isolation,
  };
}

// ---------------------------------------------------------------------------
// Budget stub (CC-shaped)
// ---------------------------------------------------------------------------

export interface WorkflowBudget {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export function createStubBudget(): WorkflowBudget {
  return Object.freeze({
    total: null,
    spent(): number {
      return 0;
    },
    remaining(): number {
      return Infinity;
    },
  });
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

export function defaultWorkflowConcurrency(availableParallelism: number): number {
  return Math.min(16, Math.max(1, availableParallelism - 2));
}

export function resolveWorkflowConcurrency(
  metaConcurrency: number | undefined,
  availableParallelism: number,
): number {
  const base = defaultWorkflowConcurrency(availableParallelism);
  if (metaConcurrency === undefined || !Number.isFinite(metaConcurrency)) return base;
  const n = Math.floor(metaConcurrency);
  if (n < 1) return 1;
  return Math.min(base, n);
}
