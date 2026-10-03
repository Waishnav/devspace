import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import { buildLocalAgentCatalog, buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import {
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";
import { writeModeAtMost } from "./local-agent-mcp-launch.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";

type RegistrationTarget = Pick<McpServer, "registerTool">;

export interface LocalAgentMcpToolOptions {
  config: ServerConfig;
  resolveScope(workspaceId: string): Promise<LocalAgentWorkspaceScope>;
  maxWriteMode?: LocalAgentWriteMode;
}

const writeModeSchema = z.enum(["read_only", "allowed", "full_access"]);
const agentIdSchema = z.string().regex(/^agt_[A-Za-z0-9_-]+$/);

export function registerLocalAgentMcpTools(
  server: RegistrationTarget,
  options: LocalAgentMcpToolOptions,
): void {
  if (!options.config.subagents.enabled) return;
  const client = createLocalAgentClient(options.config);

  server.registerTool("agent_targets", {
    title: "List agent targets",
    description: "List usable DevSpace subagent providers and profiles for an open workspace.",
    inputSchema: { workspace_id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id }) => {
    const scope = await options.resolveScope(workspace_id);
    const profiles = await loadLocalAgentProfiles(options.config, scope.workspaceRoot);
    const providers = buildLocalAgentProviderStatuses(
      options.config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, options.config.subagents),
    );
    return success(presentAgentTargetCatalog(buildLocalAgentCatalog(
      options.config.subagents,
      profiles,
      providers,
    )));
  });

  server.registerTool("agent_spawn", {
    title: "Spawn agent",
    description:
      "Start a bounded DevSpace subagent in this workspace. The child receives only this brief plus its profile instructions, not the parent conversation.",
    inputSchema: {
      workspace_id: z.string(),
      target: z.string().min(1),
      brief: z.string().min(1),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      write_mode: writeModeSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workspace_id, target, brief, model, effort, write_mode }) => {
    const scope = await options.resolveScope(workspace_id);
    const authority = authorizeWriteMode(write_mode, options.maxWriteMode);
    if (authority.error) return failure(authority.error);
    const result = await client.start({
      target,
      prompt: brief,
      workspaceId: workspace_id,
      workspaceRoot: scope.workspaceRoot,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      writeMode: authority.value,
    });
    return result.isErr() ? failure(toAgentErrorPayload(result.error as LocalAgentError)) : success(presentAgentReceipt(result.value));
  });

  server.registerTool("agent_send", {
    title: "Send agent follow-up",
    description: "Continue an existing DevSpace subagent with a related follow-up brief.",
    inputSchema: {
      workspace_id: z.string(),
      agent_id: agentIdSchema,
      brief: z.string().min(1),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      write_mode: writeModeSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workspace_id, agent_id, brief, model, effort, write_mode }) => {
    const scope = await options.resolveScope(workspace_id);
    const authority = authorizeWriteMode(write_mode, options.maxWriteMode);
    if (authority.error) return failure(authority.error);
    const result = await client.continue(agent_id, brief, {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      writeMode: authority.value,
    }, scope);
    return result.isErr() ? failure(toAgentErrorPayload(result.error as LocalAgentError)) : success(presentAgentReceipt(result.value));
  });

  server.registerTool("agent_status", {
    title: "Get agent status",
    description: "Get the current status and completed response, if any, for one DevSpace subagent.",
    inputSchema: { workspace_id: z.string(), agent_id: agentIdSchema },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, agent_id }) => {
    const scope = await options.resolveScope(workspace_id);
    const result = await client.get(agent_id, scope);
    return result.isErr() ? failure(toAgentErrorPayload(result.error as LocalAgentError)) : success(presentAgentObservation(result.value));
  });

  server.registerTool("agent_wait", {
    title: "Wait for agents",
    description: "Wait for one or more DevSpace subagents to finish their current turns. Prefer this over polling agent_status.",
    inputSchema: {
      workspace_id: z.string(),
      agent_ids: z.array(agentIdSchema).min(1),
      timeout_seconds: z.number().nonnegative().max(3600).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, agent_ids, timeout_seconds }) => {
    const scope = await options.resolveScope(workspace_id);
    const timeoutMs = timeout_seconds === undefined ? undefined : Math.round(timeout_seconds * 1000);
    const result = await client.wait(agent_ids, scope, timeoutMs);
    return result.isErr() ? failure(toAgentErrorPayload(result.error as LocalAgentError)) : success(result.value);
  });

  server.registerTool("agent_cancel", {
    title: "Cancel agent turn",
    description: "Stop an active DevSpace subagent turn while preserving its durable agent record.",
    inputSchema: { workspace_id: z.string(), agent_id: agentIdSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ workspace_id, agent_id }) => {
    const scope = await options.resolveScope(workspace_id);
    const result = await client.stopAgent(agent_id, scope);
    return result.isErr() ? failure(toAgentErrorPayload(result.error as LocalAgentError)) : success(presentAgentObservation(result.value));
  });

  server.registerTool("agent_list", {
    title: "List agents",
    description: "List durable DevSpace subagents scoped to this workspace.",
    inputSchema: { workspace_id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id }) => {
    const scope = await options.resolveScope(workspace_id);
    const result = await client.list(scope);
    return result.isErr()
      ? failure(toAgentErrorPayload(result.error as LocalAgentError))
      : success(result.value.map(presentAgentSummary));
  });
}

export function authorizeWriteMode(
  requested: LocalAgentWriteMode | undefined,
  maximum: LocalAgentWriteMode = "full_access",
): { value: LocalAgentWriteMode; error?: never } | { value?: never; error: { code: string; message: string; retryable: false } } {
  const value = requested ?? (maximum === "read_only" ? "read_only" : "allowed");
  if (writeModeAtMost(value, maximum)) return { value };
  return {
    error: {
      code: "AGENT_AUTHORITY_ESCALATION",
      retryable: false,
      message: `Child write mode ${value} exceeds the caller authority ${maximum}.`,
    },
  };
}

function success(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function failure(error: { code: string; message: string; retryable?: boolean }) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }],
    structuredContent: { error },
  };
}
