export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const WORKFLOW_DEFINITION_VERSION = 1 as const;
export const WORKFLOW_POLICY_VERSION = 1 as const;

export type WorkflowStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface AgentWorkflowNodeDefinitionV1 {
  key: string;
  type: "agent";
  config?: JsonObject;
}

export type WorkflowNodeDefinitionV1 = AgentWorkflowNodeDefinitionV1;

export interface WorkflowEdgeDefinitionV1 {
  from: string;
  to: string;
}

export interface WorkflowDefinitionV1 {
  version: typeof WORKFLOW_DEFINITION_VERSION;
  nodes: WorkflowNodeDefinitionV1[];
  edges?: WorkflowEdgeDefinitionV1[];
}

export type WorkflowDefinition = WorkflowDefinitionV1;

export interface WorkflowPolicyV1 extends JsonObject {
  version: typeof WORKFLOW_POLICY_VERSION;
}

export type WorkflowPolicy = WorkflowPolicyV1;

export interface SubmitWorkflowRequest {
  definition: WorkflowDefinition;
  input?: JsonObject;
  policy?: WorkflowPolicy;
  idempotencyKey?: string;
  workspace?: WorkflowWorkspaceScope;
}

export interface WorkflowNodeRecord {
  id: string;
  workflowId: string;
  key: string;
  type: WorkflowNodeDefinitionV1["type"];
  status: WorkflowNodeStatus;
  definition: WorkflowNodeDefinitionV1;
  attempt: number;
  claimToken?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  result?: JsonValue;
  error?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowEdgeRecord {
  workflowId: string;
  fromNodeId: string;
  toNodeId: string;
  from: string;
  to: string;
}

export interface WorkflowRunRecord {
  id: string;
  definitionVersion: typeof WORKFLOW_DEFINITION_VERSION;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  input: JsonObject;
  policy: WorkflowPolicy;
  idempotencyKey?: string;
  requestHash: string;
  workspaceId?: string;
  workspaceRoot?: string;
  result?: JsonValue;
  error?: JsonObject;
  cancellationRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  nodes: WorkflowNodeRecord[];
  edges: WorkflowEdgeRecord[];
}

export interface WorkflowEvent {
  workflowId: string;
  sequence: number;
  type: string;
  nodeId?: string;
  payload: JsonObject;
  createdAt: string;
}

export interface WorkflowEventPage {
  events: WorkflowEvent[];
  nextCursor: number;
}

export interface SubmitWorkflowResult {
  workflow: WorkflowRunRecord;
  created: boolean;
}

export interface WorkflowWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WorkflowWorkspaceScope {
  workspaceId: string;
  workspaceRoot: string;
}

export interface WorkflowSupervisorIdentity {
  ownerToken: string;
  ownerEpoch: number;
}

export interface WorkflowSupervisorRecord extends WorkflowSupervisorIdentity {
  ownerPid?: number;
  status: "starting" | "running" | "stopping" | "stopped";
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  wakeGeneration: number;
  startedAt?: string;
}

export interface WorkflowAttemptIdentity {
  workflowId: string;
  nodeKey: string;
  attempt: number;
  claimToken: string;
}

export interface WorkflowNodeAttemptRecord extends WorkflowAttemptIdentity {
  nodeId: string;
  supervisorOwnerToken: string;
  supervisorOwnerEpoch: number;
  provider: string;
  phase: "claimed" | "dispatching" | "running" | "cancelling" | "terminal";
  providerSessionId?: string;
  heartbeatAt?: string;
  cancellationRequestedAt?: string;
  terminalStatus?: "succeeded" | "failed" | "cancelled";
  result?: JsonValue;
  error?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowNodeClaimResult {
  workflow: WorkflowRunRecord;
  node: WorkflowNodeRecord;
  attempt: WorkflowNodeAttemptRecord;
}

export interface WorkflowEventReadOptions {
  after?: number;
  limit?: number;
}

export interface WorkflowNodeClaim {
  workflowId: string;
  nodeKey: string;
  claimToken: string;
  leaseMs?: number;
}

export interface WorkflowNodeTransition {
  workflowId: string;
  nodeKey: string;
  claimToken?: string;
  status: WorkflowNodeStatus;
  result?: JsonValue;
  error?: JsonObject;
  eventPayload?: JsonObject;
}

export interface WorkflowTransition {
  workflowId: string;
  status: WorkflowStatus;
  result?: JsonValue;
  error?: JsonObject;
  eventPayload?: JsonObject;
}
