import * as z from "zod/v4";

const id = z.string().trim().min(1).max(256);
const optionalText = z.string().trim().min(1).max(2_000).optional();
const runId = { runId: id };
const cursor = { cursor: id.optional(), limit: z.number().int().min(1).max(100).optional() };

export const workflowInputs = {
  run: z.object({
    script: z.string().min(1).max(256 * 1024).optional(),
    name: optionalText,
    scriptPath: optionalText,
    args: z.json().optional(),
    resumeFromRunId: id.optional(),
    agentType: optionalText,
    model: optionalText,
    effort: optionalText,
    outputTokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  get: z.object({ ...runId, afterRevision: z.number().int().nonnegative().optional(), stepId: id.optional() }).strict(),
  wait: z.object({ ...runId, afterRevision: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(0).max(60_000).optional() }).strict(),
  control: z.object({ ...runId, action: z.enum(["pause", "resume", "stop", "stop_agent", "restart_agent"]), stepId: id.optional() }).strict(),
  list: z.object({ kind: z.enum(["definitions", "runs"]).default("runs"), ...cursor }).strict(),
  save: z.object({ ...runId, name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128), location: z.enum(["project", "user"]), replace: z.boolean().optional() }).strict(),
};

export type WorkflowOperation = keyof typeof workflowInputs;
export interface WorkflowScope { workspaceId: string; workspaceRoot: string }
export type WorkflowRequest = {
  [K in WorkflowOperation]: {
    operation: K;
    scope: WorkflowScope;
    input: z.output<(typeof workflowInputs)[K]>;
  }
}[WorkflowOperation];

const envelope = z.object({
  operation: z.enum(["run", "get", "wait", "control", "list", "save"]),
  scope: z.object({ workspaceId: id, workspaceRoot: z.string().min(1).max(8_192) }).strict(),
  input: z.unknown(),
}).strict();

export function decodeWorkflowRequest(value: unknown): WorkflowRequest {
  const request = envelope.parse(value);
  const input = workflowInputs[request.operation].parse(request.input);
  if (request.operation === "run") {
    const run = input as z.output<typeof workflowInputs.run>;
    if (!run.script && !run.scriptPath && !run.name) throw new Error("Provide script, scriptPath, or name.");
  }
  if (request.operation === "control") {
    const control = input as z.output<typeof workflowInputs.control>;
    const individual = control.action === "stop_agent" || control.action === "restart_agent";
    if (individual !== Boolean(control.stepId)) throw new Error("stepId is required only for individual agent controls.");
  }
  return { ...request, input } as WorkflowRequest;
}

export interface WorkflowFailure {
  code: string; message: string; retryable: boolean; layer?: string;
  runId?: string; stepId?: string; agentId?: string; provider?: string;
  location?: { line: number; column: number };
}
export type WorkflowReply = { ok: true; result: unknown } | { ok: false; error: WorkflowFailure };

export function decodeWorkflowReply(value: unknown): WorkflowReply {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), error: z.object({
      code: z.string(), message: z.string(), retryable: z.boolean(), layer: z.string().optional(),
      runId: z.string().optional(), stepId: z.string().optional(), agentId: z.string().optional(), provider: z.string().optional(),
      location: z.object({ line: z.number(), column: z.number() }).strict().optional(),
    }).strict() }).strict(),
  ]).parse(value);
}
