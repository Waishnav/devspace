import type { Result } from "better-result";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentActivityEvent } from "./local-agent-events.js";
import type {
  LocalAgentDriverKind,
  LocalAgentProviderInstanceId,
} from "./local-agent-provider.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  modelOverrideRequested?: boolean;
  effortOverrideRequested?: boolean;
  signal?: AbortSignal;
}

export interface LocalAgentRunResult {
  provider: LocalAgentDriverKind;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRunCallbacks {
  /**
   * Called as soon as a provider creates or resolves a durable continuation
   * identity. The callback is awaited before the provider starts work that
   * could otherwise fail and lose that identity.
   */
  onSessionId?: (providerSessionId: string) => void | Promise<void>;
  /**
   * Receives normalized activity while the turn runs. It never throws, so
   * drivers may call it inline from their provider event loop.
   */
  onEvent?: (event: LocalAgentActivityEvent) => void;
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  providerInstanceId: LocalAgentProviderInstanceId;
  provider: LocalAgentDriverKind;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  agentDir?: string;
}

export type LocalAgentRuntimeScope = "instance" | "workspace" | "agent";

export type LocalAgentRuntimeAuthority = "none" | "write_mode" | "full_access_boundary";

export interface LocalAgentRuntimePolicy {
  scope: LocalAgentRuntimeScope;
  authority?: LocalAgentRuntimeAuthority;
  idleTimeoutMs?: number;
  sessionIdleTimeoutMs?: number;
}

export interface LocalAgentCapabilities {
  sessions: { resume: boolean; close: boolean };
  /** `streaming` means the driver reports messages and tool activity while a turn runs. */
  turns: { interrupt: boolean; streaming: boolean };
  configuration: { modelOverride: boolean; effortOverride: boolean };
  permissions: { enforcement: "native" | "client-boundary" | "unsupported" };
  mcp: { supported: boolean };
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentDriverKind;
  run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ): Promise<Result<LocalAgentRunResult, AgentProviderError>>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentDriver {
  readonly providerInstanceId: LocalAgentProviderInstanceId;
  readonly provider: LocalAgentDriverKind;
  readonly runtimePolicy: LocalAgentRuntimePolicy;
  readonly capabilities: LocalAgentCapabilities;
  createRuntime(context: LocalAgentRuntimeContext): Promise<Result<LocalAgentRuntime, AgentProviderError>>;
}
