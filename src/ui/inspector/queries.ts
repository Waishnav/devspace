import { queryOptions } from "@tanstack/react-query";
import type { WorkspaceDiffScopeInput, WorkspaceInspectorTransport } from "./transport.js";

export function workspaceActivityQuery(
  transport: WorkspaceInspectorTransport,
  workspaceId: string,
  reviewRef?: string,
) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "activity", reviewRef ?? "all"] as const,
    queryFn: () => transport.getActivity(workspaceId, reviewRef),
    staleTime: 5_000,
  });
}

export function workspaceToolCallQuery(
  transport: WorkspaceInspectorTransport,
  workspaceId: string,
  callId: number,
) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "tool-call", callId] as const,
    queryFn: () => transport.getToolCall(workspaceId, callId),
    staleTime: Infinity,
  });
}

export function workspaceDiffQuery(
  transport: WorkspaceInspectorTransport,
  workspaceId: string,
  scope: WorkspaceDiffScopeInput,
) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "diff", scope] as const,
    queryFn: () => transport.getDiff(workspaceId, scope),
    staleTime: scope.kind === "review" || scope.kind === "compare" ? Infinity : 0,
  });
}

export function workspaceRefsQuery(
  transport: WorkspaceInspectorTransport,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "refs"] as const,
    queryFn: () => transport.getRefs(workspaceId),
    staleTime: 5_000,
  });
}
