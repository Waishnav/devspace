import type { FromSchema } from "json-schema-to-ts";
import * as z from "zod/v4";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { jsonSchemaSchema, type JsonSchema, type JsonValue } from "./json-types.js";

export const localAgentProviderSchema = z.enum(LOCAL_AGENT_PROVIDERS);

export const workflowMetaSchema = z
  .object({
    name: z.string().trim().min(1).regex(/^[a-z0-9-]+$/),
    description: z.string().trim().min(1),
    phases: z
      .array(
        z
          .object({
            title: z.string().trim().min(1),
            detail: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    whenToUse: z.string().trim().min(1).optional(),
    defaultProvider: localAgentProviderSchema.optional(),
    concurrency: z.number().finite().int().positive().optional(),
  })
  .strict();

export type WorkflowMeta = z.infer<typeof workflowMetaSchema>;
export type WorkflowPhaseMeta = NonNullable<WorkflowMeta["phases"]>[number];

export const agentIsolationModeSchema = z.enum(["shared", "worktree"]);
export type AgentIsolationMode = z.infer<typeof agentIsolationModeSchema>;

export const workflowRunStatusSchema = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowAgentCallStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "from_cache",
]);
export type WorkflowAgentCallStatus = z.infer<typeof workflowAgentCallStatusSchema>;

export const workflowRunSourceSchema = z.enum(["inline", "named", "resume"]);
export type WorkflowRunSource = z.infer<typeof workflowRunSourceSchema>;

export const agentOptsSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    phase: z.string().trim().min(1).optional(),
    schema: jsonSchemaSchema.optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    provider: localAgentProviderSchema.optional(),
    isolation: z.literal("worktree").optional(),
  })
  .strict();

export type AgentOpts<S extends JsonSchema | undefined = JsonSchema | undefined> = Omit<
  z.infer<typeof agentOptsSchema>,
  "schema"
> & {
  schema?: S;
};

export interface WorkflowAgent {
  <const S extends JsonSchema>(
    prompt: string,
    opts: AgentOpts<S> & { schema: S },
  ): Promise<FromSchema<S>>;
  (prompt: string, opts?: AgentOpts<undefined>): Promise<string>;
}

export type WorkflowTask<T = unknown> = () => T | Promise<T>;

export interface WorkflowParallel {
  <const T extends readonly WorkflowTask[]>(
    tasks: T,
  ): Promise<{
    [K in keyof T]: Awaited<ReturnType<T[K]>> | null;
  }>;
}

export interface WorkflowPipeline {
  <T, R>(
    items: readonly T[],
    stage: (previous: T, item: T, index: number) => R | Promise<R>,
  ): Promise<Array<Awaited<R> | null>>;
  <T, A, R>(
    items: readonly T[],
    first: (previous: T, item: T, index: number) => A | Promise<A>,
    second: (previous: Awaited<A>, item: T, index: number) => R | Promise<R>,
  ): Promise<Array<Awaited<R> | null>>;
  (...args: unknown[]): Promise<Array<unknown | null>>;
}

export interface WorkflowNested {
  (nameOrRef: string | { scriptPath: string }, args?: JsonValue): Promise<unknown>;
}

export const workflowErrorKindSchema = z.enum([
  "syntax",
  "meta",
  "determinism",
  "provider_disabled",
  "provider_unavailable",
  "no_provider",
  "provider",
  "schema",
  "cancelled",
  "timeout",
  "heartbeat",
  "worktree",
  "nest_depth",
  "path",
  "result_too_large",
  "args_too_large",
  "script_too_large",
  "internal",
]);
export type WorkflowErrorKind = z.infer<typeof workflowErrorKindSchema>;

export const WORKFLOW_EVENT_TYPES = [
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "phase_started",
  "log",
  "agent_call_started",
  "agent_call_completed",
  "agent_call_failed",
  "agent_call_cached",
  "schema_retry",
  "worktree_created",
  "worktree_finalized",
] as const;

export const workflowEventTypeSchema = z.enum(WORKFLOW_EVENT_TYPES);
export type WorkflowEventType = z.infer<typeof workflowEventTypeSchema>;

export const workflowEventPayloadSchemas = {
  run_started: z
    .object({
      name: z.string(),
      scriptHash: z.string(),
      concurrency: z.number().int().positive(),
    })
    .strict(),
  run_completed: z.object({ callCount: z.number().int().nonnegative() }).strict(),
  run_failed: z
    .object({ error: z.string(), errorKind: workflowErrorKindSchema })
    .strict(),
  run_cancelled: z.object({ reason: z.string().optional() }).strict(),
  phase_started: z.object({ title: z.string().min(1) }).strict(),
  log: z.object({ message: z.string() }).strict(),
  agent_call_started: z
    .object({
      callIndex: z.number().int().nonnegative(),
      cacheKey: z.string(),
      provider: localAgentProviderSchema,
      isolation: agentIsolationModeSchema,
      worktreePath: z.string().optional(),
    })
    .strict(),
  agent_call_completed: z
    .object({
      callIndex: z.number().int().nonnegative(),
      provider: localAgentProviderSchema,
      isolation: agentIsolationModeSchema,
      worktreePath: z.string().optional(),
      dirty: z.boolean().optional(),
      fromCache: z.boolean(),
    })
    .strict(),
  agent_call_failed: z
    .object({
      callIndex: z.number().int().nonnegative(),
      error: z.string(),
      cleanupError: z.string().optional(),
      isolation: agentIsolationModeSchema,
      worktreePath: z.string().optional(),
    })
    .strict(),
  agent_call_cached: z
    .object({
      callIndex: z.number().int().nonnegative(),
      cacheKey: z.string(),
      provider: localAgentProviderSchema,
    })
    .strict(),
  schema_retry: z
    .object({
      callIndex: z.number().int().nonnegative(),
      attempt: z.number().int().positive(),
      errors: z.string(),
      mode: z.enum(["native", "prompt"]),
    })
    .strict(),
  worktree_created: z
    .object({
      callIndex: z.number().int().nonnegative(),
      worktreePath: z.string(),
      isolation: z.literal("worktree"),
    })
    .strict(),
  worktree_finalized: z
    .object({
      callIndex: z.number().int().nonnegative(),
      worktreePath: z.string().optional(),
      dirty: z.boolean(),
      removed: z.boolean(),
      outcome: z.literal("failure").optional(),
    })
    .strict(),
} as const satisfies Record<WorkflowEventType, z.ZodTypeAny>;

export type WorkflowEventPayloads = {
  [K in WorkflowEventType]: z.infer<(typeof workflowEventPayloadSchemas)[K]>;
};

export type AppendWorkflowEventInput<K extends WorkflowEventType = WorkflowEventType> = {
  [P in K]: {
    runId: string;
    type: P;
    phase?: string;
    label?: string;
    data: WorkflowEventPayloads[P];
  };
}[K];

export function parseWorkflowEventPayload<K extends WorkflowEventType>(
  type: K,
  data: unknown,
): WorkflowEventPayloads[K] {
  return workflowEventPayloadSchemas[type].parse(data) as WorkflowEventPayloads[K];
}

export type WorkflowProviderId = LocalAgentProvider;
