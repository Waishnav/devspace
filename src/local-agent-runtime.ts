import type { Result } from "better-result";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";
export type LocalAgentToolPolicy = "normal" | "read_only" | "none";

export type LocalAgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LocalAgentJsonValue[]
  | { readonly [key: string]: LocalAgentJsonValue };

export type LocalAgentJsonSchema = Record<string, LocalAgentJsonValue>;

export interface LocalAgentCapabilities {
  cancellation: "turn" | "dedicated_process" | "unsupported";
  structuredOutput: "native" | "validated_text";
  usage: "streaming" | "final" | "unavailable";
  correctionAuthority: "no_tools" | "read_only" | "unsupported";
  permissionRequests: "interactive" | "preconfigured";
  progress: "tools_and_text" | "text" | "final_only";
}

export interface LocalAgentUsageUpdate {
  attemptId: string;
  sequence: number;
  outputTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  final: boolean;
}

export type LocalAgentProgressUpdate =
  | { type: "text"; text: string; final?: boolean }
  | { type: "tool"; toolName: string; status: "started" | "updated" | "completed"; summary?: string };

export interface LocalAgentPermissionRequest {
  requestId: string;
  description: string;
  options: readonly { id: string; label: string; kind: string }[];
}

export type LocalAgentPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface LocalAgentRunControl {
  signal: AbortSignal;
}

export interface LocalAgentRunInput {
  prompt: string;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  modelOverrideRequested?: boolean;
  effortOverrideRequested?: boolean;
  attemptId?: string;
  outputSchema?: LocalAgentJsonSchema;
  toolPolicy?: LocalAgentToolPolicy;
  workflowRunId?: string;
  workflowStepId?: string;
  workflowAttemptId?: string;
}

export interface LocalAgentRunResult {
  provider: LocalAgentProvider;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
  structuredOutput?: LocalAgentJsonValue;
  usage?: LocalAgentUsageUpdate;
}

export interface LocalAgentRunCallbacks {
  /**
   * Called as soon as a provider creates or resolves a durable continuation
   * identity. The callback is awaited before the provider starts work that
   * could otherwise fail and lose that identity.
   */
  onSessionId?: (providerSessionId: string) => void | Promise<void>;
  onUsage?: (usage: LocalAgentUsageUpdate) => void | Promise<void>;
  onProgress?: (progress: LocalAgentProgressUpdate) => void | Promise<void>;
  onPermissionRequest?: (
    request: LocalAgentPermissionRequest,
  ) => LocalAgentPermissionDecision | Promise<LocalAgentPermissionDecision>;
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  provider: LocalAgentProvider;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  outputSchema?: LocalAgentJsonSchema;
  toolPolicy?: LocalAgentToolPolicy;
  workflowRunId?: string;
  workflowStepId?: string;
  workflowAttemptId?: string;
  agentDir?: string;
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
    control?: LocalAgentRunControl,
  ): Promise<Result<LocalAgentRunResult, AgentProviderError>>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentDriver {
  readonly provider: LocalAgentProvider;
  runtimeKey(context: LocalAgentRuntimeContext): string;
  createRuntime(context: LocalAgentRuntimeContext): Promise<Result<LocalAgentRuntime, AgentProviderError>>;
  capabilities?(context: LocalAgentRuntimeContext, input: LocalAgentRunInput): LocalAgentCapabilities;
  readonly idleTimeoutMs?: number;
}

export function localAgentCapabilities(
  driver: LocalAgentDriver,
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
): LocalAgentCapabilities {
  return driver.capabilities?.(context, input) ?? {
    cancellation: "unsupported",
    structuredOutput: "validated_text",
    usage: "unavailable",
    correctionAuthority: "unsupported",
    permissionRequests: "preconfigured",
    progress: "final_only",
  };
}

export function localAgentWorkflowEnvironment(
  env: NodeJS.ProcessEnv,
  provenance: Pick<LocalAgentRuntimeContext, "workflowRunId" | "workflowStepId" | "workflowAttemptId">,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.DEVSPACE_WORKFLOW_RUN_ID;
  delete sanitized.DEVSPACE_WORKFLOW_STEP_ID;
  delete sanitized.DEVSPACE_WORKFLOW_ATTEMPT_ID;
  return {
    ...sanitized,
    ...(provenance.workflowRunId ? { DEVSPACE_WORKFLOW_RUN_ID: provenance.workflowRunId } : {}),
    ...(provenance.workflowStepId ? { DEVSPACE_WORKFLOW_STEP_ID: provenance.workflowStepId } : {}),
    ...(provenance.workflowAttemptId ? { DEVSPACE_WORKFLOW_ATTEMPT_ID: provenance.workflowAttemptId } : {}),
  };
}
