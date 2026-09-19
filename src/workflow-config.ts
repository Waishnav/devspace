import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { localAgentProviderConfigRevision, type SubagentsConfig } from "./local-agent-config.js";

const positive = (fallback: number, maximum = 2_147_483_647) =>
  z.number().int().positive().max(maximum).default(fallback);

export const workflowsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  defaultAgentType: z.string().trim().min(1).optional(),
  packageRoots: z.array(z.string().trim().min(1)).max(100).default([]),
  maxConcurrentAgents: positive(16, 256),
  maxConcurrentRuns: positive(4, 32),
  maxAgentsPerRun: positive(1_000, 10_000),
  maxAttemptsPerRun: positive(5_000, 50_000),
  defaultOutputTokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxOutputTokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  requireWorktreesForConcurrentWrites: z.boolean().default(false),
  maxUsageLimitWaits: z.number().int().min(0).max(10).default(2),
  maxUsageLimitWaitMs: positive(86_400_000, 86_400_000),
  limits: z.object({
    scriptBytes: positive(256 * 1024),
    argsBytes: positive(1024 * 1024),
    promptBytes: positive(1024 * 1024),
    schemaBytes: positive(128 * 1024),
    schemaDepth: positive(64, 256),
    agentResultBytes: positive(4 * 1024 * 1024),
    runResultBytes: positive(16 * 1024 * 1024),
    guestHeapBytes: positive(64 * 1024 * 1024),
    guestStackBytes: positive(1024 * 1024),
    guestSliceMs: positive(1_000),
    guestTotalCpuMs: positive(30_000),
    runActiveMs: positive(6 * 60 * 60 * 1_000),
    logMessageBytes: positive(8 * 1024),
    logTotalBytes: positive(1024 * 1024),
    eventsPerRun: positive(100_000),
  }).strict().prefault({}),
}).strict().prefault({});

export type WorkflowsConfig = z.output<typeof workflowsConfigSchema>;
export const defaultWorkflowsConfig = (): WorkflowsConfig => workflowsConfigSchema.parse({});

/** Workflow policy changes must not reuse a daemon with stale execution authority. */
export function executionConfigRevision(config: { subagents: SubagentsConfig; workflows?: WorkflowsConfig; allowedRoots?: readonly string[]; worktreeRoot?: string }): string {
  const agents = localAgentProviderConfigRevision(config.subagents);
  if (!config.workflows) return agents;
  return createHash("sha256").update(JSON.stringify([agents, config.workflows, config.allowedRoots, config.worktreeRoot])).digest("hex");
}
