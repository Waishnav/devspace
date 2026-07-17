import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import { loadLocalAgentProfiles } from "../local-agent-profiles.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import { createWorkflowSubmission } from "./submission.js";
import { ensureSupervisor } from "./supervisor-launch.js";
import type { WorkflowEvent, WorkflowRunRecord, WorkflowWorkspaceScope } from "./types.js";

const CONTRACT_VERSION = 1 as const;
const MAX_WAIT_MS = 300_000;
const MAX_EVENT_LIMIT = 1_000;

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  retryOn: z.array(z.enum(["provider_failed", "timed_out"])).max(2).optional(),
  backoffMs: z.number().int().min(0).max(60_000).optional(),
}).strict();

const agentNodeSchema = z.object({
  key: z.string().min(1).max(64),
  target: z.string().min(1).max(128),
  prompt: z.string().min(1).max(200_000),
  model: z.string().min(1).max(256).optional(),
  thinking: z.string().min(1).max(64).optional(),
  access: z.enum(["read_only", "workspace_write"]).optional(),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  retry: retrySchema.optional(),
}).strict();

const dagSchema = z.object({
  version: z.literal(1),
  nodes: z.array(agentNodeSchema).min(1).max(64),
  edges: z.array(z.object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
  }).strict()).max(256).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  access: z.enum(["read_only", "workspace_write"]).optional(),
}).strict();

const nodeOutputSchema = z.object({
  key: z.string(),
  status: z.enum(["pending", "ready", "running", "succeeded", "failed", "cancelled", "skipped"]),
  attempt: z.number().int(),
  completedAt: z.string().optional(),
  errorCode: z.string().optional(),
  finalResponse: z.string().optional(),
});

const workflowOutputSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]),
  maxConcurrency: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  cancellationRequestedAt: z.string().optional(),
  errorCode: z.string().optional(),
  finalResponse: z.string().optional(),
  nodes: z.array(nodeOutputSchema),
});

const supervisorOutputSchema = z.object({
  started: z.boolean(),
  errorCode: z.string().optional(),
});

const eventOutputSchema = z.object({
  sequence: z.number().int(),
  type: z.string(),
  nodeKey: z.string().optional(),
  createdAt: z.string(),
});

const commonOutput = {
  version: z.literal(CONTRACT_VERSION),
  result: z.string(),
};

export interface WorkflowToolAuditEvent {
  tool: string;
  workspaceId?: string;
  workflowId?: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
}

export function registerWorkflowTools(input: {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  orchestrator: WorkflowOrchestrator;
  launchSupervisor?: typeof ensureSupervisor;
  audit?: (event: WorkflowToolAuditEvent) => void;
}): void {
  const { server, config, workspaces, orchestrator } = input;
  const launchSupervisor = input.launchSupervisor ?? ensureSupervisor;

  server.registerTool(
    "workflow_run",
    {
      title: "Run workflow",
      description: "Submit a durable local-agent workflow. Provide either target/prompt for one agent or a versioned DAG.",
      inputSchema: {
        workspaceId: z.string().min(1),
        target: z.string().min(1).max(128).optional(),
        prompt: z.string().min(1).max(200_000).optional(),
        model: z.string().min(1).max(256).optional(),
        thinking: z.string().min(1).max(64).optional(),
        access: z.enum(["read_only", "workspace_write"]).optional(),
        timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
        retry: retrySchema.optional(),
        dag: dagSchema.optional(),
        idempotencyKey: z.string().min(1).max(256).optional(),
      },
      outputSchema: {
        ...commonOutput,
        created: z.boolean(),
        supervisor: supervisorOutputSchema,
        workflow: workflowOutputSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => audited(input.audit, "workflow_run", args.workspaceId, undefined, async () => {
      const hasSingleFields = [
        args.target,
        args.prompt,
        args.model,
        args.thinking,
        args.access,
        args.timeoutMs,
        args.retry,
      ].some((value) => value !== undefined);
      if (args.dag && hasSingleFields) {
        throw new Error("Provide either dag or single-agent fields, not both");
      }
      if (!args.dag && (!args.target || !args.prompt)) {
        throw new Error("Single-agent workflows require target and prompt");
      }
      const scope = workspaceScope(workspaces, args.workspaceId);
      const workspace = workspaces.getWorkspace(args.workspaceId);
      const profiles = workspace.agentProfiles.length > 0
        ? workspace.agentProfiles
        : await loadLocalAgentProfiles(config, workspace.root);
      const request = await createWorkflowSubmission({
        intent: {
          single: args.dag ? undefined : {
            target: args.target ?? "",
            prompt: args.prompt ?? "",
            model: args.model,
            thinking: args.thinking,
            access: args.access,
            timeoutMs: args.timeoutMs,
            retry: args.retry,
          },
          dag: args.dag,
          idempotencyKey: args.idempotencyKey,
        },
        workspace: scope,
        profiles,
        worktreeRoot: config.worktreeRoot,
      });
      const submitted = orchestrator.submitDetailed(request);
      const supervisor = await supervisorStartState(() => launchSupervisor({ stateDir: config.stateDir }));
      const workflow = publicWorkflow(submitted.workflow);
      const result = supervisor.started
        ? submitted.created
          ? `Workflow ${workflow.id} was submitted with status ${workflow.status}.`
          : `Workflow ${workflow.id} already exists for this idempotency key.`
        : `Workflow ${workflow.id} was durably submitted, but its supervisor could not be started.`;
      return response({ version: CONTRACT_VERSION, result, created: submitted.created, supervisor, workflow });
    }),
  );

  server.registerTool(
    "workflow_status",
    {
      title: "Get workflow status",
      description: "Read the current durable workflow and node states for a workspace.",
      inputSchema: { workspaceId: z.string().min(1), workflowId: z.string().min(1) },
      outputSchema: { ...commonOutput, workflow: workflowOutputSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, workflowId }) => audited(input.audit, "workflow_status", workspaceId, workflowId, async () => {
      const workflow = publicWorkflow(requireOwned(orchestrator, workflowId, workspaceScope(workspaces, workspaceId)));
      const result = `Workflow ${workflow.id} is ${workflow.status}.`;
      return response({ version: CONTRACT_VERSION, result, workflow });
    }),
  );

  server.registerTool(
    "workflow_wait",
    {
      title: "Wait for workflow",
      description: "Wait for a bounded interval, then return the latest durable workflow state.",
      inputSchema: {
        workspaceId: z.string().min(1),
        workflowId: z.string().min(1),
        timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
      },
      outputSchema: { ...commonOutput, timedOut: z.boolean(), workflow: workflowOutputSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, workflowId, timeoutMs }) => audited(input.audit, "workflow_wait", workspaceId, workflowId, async () => {
      const scope = workspaceScope(workspaces, workspaceId);
      const current = requireOwned(orchestrator, workflowId, scope);
      const waited = await orchestrator.waitForWorkspace(workflowId, scope, { timeoutMs });
      const workflow = publicWorkflow(waited);
      const timedOut = !isTerminal(waited) && !isTerminal(current);
      const result = timedOut
        ? `Workflow ${workflow.id} is still ${workflow.status} after the bounded wait.`
        : `Workflow ${workflow.id} reached ${workflow.status}.`;
      return response({ version: CONTRACT_VERSION, result, timedOut, workflow });
    }),
  );

  server.registerTool(
    "workflow_events",
    {
      title: "Read workflow events",
      description: "Read an ordered page of redacted durable workflow lifecycle events.",
      inputSchema: {
        workspaceId: z.string().min(1),
        workflowId: z.string().min(1),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
      },
      outputSchema: {
        ...commonOutput,
        workflowId: z.string(),
        events: z.array(eventOutputSchema),
        cursor: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, workflowId, after, limit }) => audited(input.audit, "workflow_events", workspaceId, workflowId, async () => {
      const scope = workspaceScope(workspaces, workspaceId);
      const workflow = requireOwned(orchestrator, workflowId, scope);
      const page = orchestrator.eventsForWorkspace(workflowId, scope, { after, limit });
      const events = page.events.map((event) => publicEvent(event, workflow));
      const result = `Read ${events.length} event${events.length === 1 ? "" : "s"} for workflow ${workflowId}.`;
      return response({
        version: CONTRACT_VERSION,
        result,
        workflowId,
        events,
        cursor: page.nextCursor,
      });
    }),
  );

  server.registerTool(
    "workflow_cancel",
    {
      title: "Cancel workflow",
      description: "Request durable cancellation of a workflow and its active local agents.",
      inputSchema: { workspaceId: z.string().min(1), workflowId: z.string().min(1) },
      outputSchema: { ...commonOutput, supervisor: supervisorOutputSchema, workflow: workflowOutputSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, workflowId }) => audited(input.audit, "workflow_cancel", workspaceId, workflowId, async () => {
      const scope = workspaceScope(workspaces, workspaceId);
      requireOwned(orchestrator, workflowId, scope);
      const cancelled = orchestrator.cancelForWorkspace(workflowId, scope);
      const supervisor = await supervisorStartState(() => launchSupervisor({ stateDir: config.stateDir }));
      const workflow = publicWorkflow(cancelled);
      const result = supervisor.started
        ? `Cancellation was requested for workflow ${workflow.id}; current status is ${workflow.status}.`
        : `Cancellation was durably requested for workflow ${workflow.id}, but its supervisor could not be started.`;
      return response({ version: CONTRACT_VERSION, result, supervisor, workflow });
    }),
  );
}

function workspaceScope(workspaces: WorkspaceRegistry, workspaceId: string): WorkflowWorkspaceScope {
  const workspace = workspaces.getWorkspace(workspaceId);
  return { workspaceId: workspace.id, workspaceRoot: workspace.root };
}

function requireOwned(
  orchestrator: WorkflowOrchestrator,
  workflowId: string,
  scope: WorkflowWorkspaceScope,
): WorkflowRunRecord {
  const workflow = orchestrator.getForWorkspace(workflowId, scope);
  if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
  return workflow;
}

function publicWorkflow(workflow: WorkflowRunRecord) {
  return {
    id: workflow.id,
    status: workflow.status,
    maxConcurrency: workflow.maxConcurrency,
    createdAt: workflow.createdAt,
    startedAt: workflow.startedAt,
    completedAt: workflow.completedAt,
    cancellationRequestedAt: workflow.cancellationRequestedAt,
    errorCode: stringField(workflow.error, "code"),
    finalResponse: stringField(workflow.result, "finalResponse"),
    nodes: workflow.nodes.map((node) => ({
      key: node.key,
      status: node.status,
      attempt: node.attempt,
      completedAt: node.completedAt,
      errorCode: stringField(node.error, "code"),
      finalResponse: stringField(node.result, "finalResponse"),
    })),
  };
}

function publicEvent(event: WorkflowEvent, workflow: WorkflowRunRecord) {
  const node = event.nodeId ? workflow.nodes.find((candidate) => candidate.id === event.nodeId) : undefined;
  return {
    sequence: event.sequence,
    type: event.type,
    nodeKey: node?.key,
    createdAt: event.createdAt,
  };
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

async function supervisorStartState(start: () => Promise<unknown>): Promise<{
  started: boolean;
  errorCode?: string;
}> {
  try {
    await start();
    return { started: true };
  } catch {
    return { started: false, errorCode: "supervisor_start_failed" };
  }
}

async function audited<T>(
  audit: ((event: WorkflowToolAuditEvent) => void) | undefined,
  tool: string,
  workspaceId: string | undefined,
  workflowId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    emitAudit(audit, {
      tool,
      workspaceId,
      workflowId,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    emitAudit(audit, {
      tool,
      workspaceId,
      workflowId,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: error instanceof Error ? error.name : "Error",
    });
    throw error;
  }
}

function emitAudit(
  audit: ((event: WorkflowToolAuditEvent) => void) | undefined,
  event: WorkflowToolAuditEvent,
): void {
  try {
    audit?.(event);
  } catch {
    // Audit failures must not change workflow tool behavior.
  }
}

function response<T extends { result: string }>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: structuredContent.result }],
    structuredContent,
  };
}

function isTerminal(workflow: WorkflowRunRecord): boolean {
  return workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled";
}
