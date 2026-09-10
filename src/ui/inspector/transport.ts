import type { App } from "@modelcontextprotocol/ext-apps";
import * as z from "zod/v4";

const activityCallSchema = z.object({
  id: z.number().int(),
  tool_name: z.string(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  duration_ms: z.number().int().optional(),
});

const activityGroupSchema = z.object({
  id: z.string(),
  kind: z.enum(["review", "inferred"]),
  started_at: z.string(),
  completed_at: z.string().optional(),
  review_ref: z.string().optional(),
  calls: z.array(activityCallSchema),
});

export const workspaceActivityDataSchema = z.object({
  groups: z.array(activityGroupSchema),
});

export const workspaceToolCallDataSchema = z.object({
  call: z.object({
    id: z.number().int(),
    tool_name: z.string(),
    arguments: z.unknown(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    started_at: z.string(),
    completed_at: z.string().optional(),
    duration_ms: z.number().int().optional(),
    review_ref: z.string().optional(),
  }),
});

export const workspaceDiffDataSchema = z.object({
  scope: z.unknown(),
  summary: z.object({
    files: z.number().int(),
    additions: z.number().int(),
    removals: z.number().int(),
  }),
  files: z.array(z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    additions: z.number().int(),
    removals: z.number().int(),
  })),
  patch: z.string(),
});

export const workspaceRefsDataSchema = z.object({
  current_ref: z.string().optional(),
  default_base_ref: z.string().optional(),
  refs: z.array(z.string()),
});

export type WorkspaceActivityData = z.infer<typeof workspaceActivityDataSchema>;
export type WorkspaceToolCallData = z.infer<typeof workspaceToolCallDataSchema>["call"];
export type WorkspaceDiffData = z.infer<typeof workspaceDiffDataSchema>;
export type WorkspaceRefsData = z.infer<typeof workspaceRefsDataSchema>;

export type WorkspaceDiffScopeInput =
  | { kind: "review"; review_ref: string }
  | { kind: "working-tree" }
  | { kind: "branch"; base_ref?: string }
  | { kind: "compare"; from_ref: string; to_ref: string };

export interface WorkspaceInspectorTransport {
  getActivity(workspaceId: string, reviewRef?: string): Promise<WorkspaceActivityData>;
  getToolCall(workspaceId: string, callId: number): Promise<WorkspaceToolCallData>;
  getDiff(workspaceId: string, scope: WorkspaceDiffScopeInput): Promise<WorkspaceDiffData>;
  getRefs(workspaceId: string): Promise<WorkspaceRefsData>;
}

export function createMcpInspectorTransport(app: App): WorkspaceInspectorTransport {
  return {
    async getActivity(workspaceId, reviewRef) {
      return parseStructured(
        await app.callServerTool({
          name: "get_workspace_activity",
          arguments: {
            workspace_id: workspaceId,
            ...(reviewRef ? { review_ref: reviewRef } : {}),
          },
        }),
        workspaceActivityDataSchema,
      );
    },
    async getToolCall(workspaceId, callId) {
      return parseStructured(
        await app.callServerTool({
          name: "get_workspace_tool_call",
          arguments: { workspace_id: workspaceId, call_id: callId },
        }),
        workspaceToolCallDataSchema,
      ).call;
    },
    async getDiff(workspaceId, scope) {
      return parseStructured(
        await app.callServerTool({
          name: "get_workspace_diff",
          arguments: { workspace_id: workspaceId, scope },
        }),
        workspaceDiffDataSchema,
      );
    },
    async getRefs(workspaceId) {
      return parseStructured(
        await app.callServerTool({
          name: "get_workspace_refs",
          arguments: { workspace_id: workspaceId },
        }),
        workspaceRefsDataSchema,
      );
    },
  };
}

function parseStructured<T>(
  result: { structuredContent?: unknown; isError?: boolean },
  schema: z.ZodType<T>,
): T {
  if (result.isError) throw new Error("Workspace inspector request failed.");
  return schema.parse(result.structuredContent);
}
