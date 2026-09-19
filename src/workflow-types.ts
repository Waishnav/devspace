export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = JsonObject | boolean;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  isolation?: "worktree";
  agentType?: string;
}

export interface WorkflowLocation {
  line: number;
  column: number;
}

export interface WorkflowError {
  code: string;
  message: string;
  layer: "script" | "workflow" | "workspace" | "adapter" | "provider";
  retryable: boolean;
  runId?: string;
  stepId?: string;
  agentId?: string;
  provider?: string;
  location?: WorkflowLocation;
}

export interface ParsedWorkflowScript {
  source: string;
  body: string;
  meta: WorkflowMeta;
  filename: string;
  sourceBytes: number;
}

export interface WorkflowBudgetSnapshot {
  total: number | null;
  knownSpent: number;
  complete: boolean;
}

export interface WorkflowRuntimeLimits {
  argsBytes: number;
  promptBytes: number;
  schemaBytes: number;
  schemaDepth: number;
  agentResultBytes: number;
  runResultBytes: number;
  guestHeapBytes: number;
  guestStackBytes: number;
  guestSliceMs: number;
  guestTotalCpuMs: number;
  runActiveMs: number;
  logMessageBytes: number;
  logTotalBytes: number;
  eventsPerRun: number;
  maxAgents: number;
  maxAttempts: number;
  maxNestedWorkflows: number;
  maxPendingRequests: number;
  maxCombinatorItems: number;
}

export const DEFAULT_WORKFLOW_RUNTIME_LIMITS: WorkflowRuntimeLimits = {
  argsBytes: 1024 * 1024,
  promptBytes: 1024 * 1024,
  schemaBytes: 128 * 1024,
  schemaDepth: 64,
  agentResultBytes: 4 * 1024 * 1024,
  runResultBytes: 16 * 1024 * 1024,
  guestHeapBytes: 64 * 1024 * 1024,
  guestStackBytes: 1024 * 1024,
  guestSliceMs: 1_000,
  guestTotalCpuMs: 30_000,
  runActiveMs: 6 * 60 * 60 * 1_000,
  logMessageBytes: 8 * 1024,
  logTotalBytes: 1024 * 1024,
  eventsPerRun: 100_000,
  maxAgents: 1_000,
  maxAttempts: 5_000,
  maxNestedWorkflows: 1_000,
  maxPendingRequests: 4_096,
  maxCombinatorItems: 4_096,
};

export interface WorkflowBridgeContext {
  generation: number;
  requestId: number;
  signal: AbortSignal;
}

export interface WorkflowAgentRequest {
  prompt: string;
  options: AgentOptions;
  phase?: string;
  location?: WorkflowLocation;
}

export interface WorkflowNestedRequest {
  reference: string | { scriptPath: string };
  argsPresent: boolean;
  args?: JsonValue;
  phase?: string;
  location?: WorkflowLocation;
}

export type WorkflowRuntimeEvent =
  | { type: "phase"; title: string; replayed: boolean }
  | { type: "log"; message: string; replayed: boolean }
  | { type: "combinator_error"; combinator: "parallel" | "pipeline"; index: number; error: WorkflowError }
  | { type: "budget_observation"; getter: "spent" | "remaining"; observationIndex: number;
      value: number | "Infinity"; location?: WorkflowLocation; replayed: boolean }
  | { type: "replay_diverged"; reason: string }
  | { type: "delivery"; requestId: number; deliverySequence: number; replayed: boolean };

export interface WorkflowBridgeReply {
  value: JsonValue;
  budget?: WorkflowBudgetSnapshot;
  replayed?: boolean;
}

export interface WorkflowRuntimeCallbacks {
  agent(request: WorkflowAgentRequest, context: WorkflowBridgeContext): Promise<WorkflowBridgeReply>;
  workflow(request: WorkflowNestedRequest, context: WorkflowBridgeContext): Promise<WorkflowBridgeReply>;
  event(event: WorkflowRuntimeEvent): void | Promise<void>;
  control?(point: "before_request" | "before_delivery"): Promise<void>;
  budget?(): WorkflowBudgetSnapshot;
  nextDeliverySequence?(): number;
  waitForActiveTimeout?(timeoutMs: number, signal: AbortSignal): Promise<void>;
}

export interface WorkflowRuntimeInput {
  script: ParsedWorkflowScript;
  argsPresent: boolean;
  args?: JsonValue;
  generation: number;
  depth: 0 | 1;
  budget: WorkflowBudgetSnapshot;
  limits?: Partial<WorkflowRuntimeLimits>;
  signal: AbortSignal;
  callbacks: WorkflowRuntimeCallbacks;
  replay?: WorkflowReplayInput;
}

export interface WorkflowReplayInput {
  events?: Array<
    | { type: "phase"; title: string }
    | { type: "log"; message: string }
  >;
  budgetObservations?: Array<{
    getter: "spent" | "remaining";
    value: number | "Infinity";
    location?: WorkflowLocation;
  }>;
}

export interface WorkflowRuntimeResult {
  result: JsonValue;
  omittedResult: boolean;
  partial: boolean;
}

export interface StructuredOutputValidation {
  valid: boolean;
  value?: JsonValue;
  errors?: string[];
}
