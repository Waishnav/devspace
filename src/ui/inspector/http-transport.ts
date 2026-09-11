import {
  workspaceActivityDataSchema,
  workspaceDiffDataSchema,
  workspaceRefsDataSchema,
  workspaceToolCallDataSchema,
  type WorkspaceDiffScopeInput,
  type WorkspaceInspectorTransport,
} from "./transport.js";

export function createHttpInspectorTransport(): WorkspaceInspectorTransport {
  return {
    getActivity(workspaceId, reviewRef) {
      const search = reviewRef ? `?review=${encodeURIComponent(reviewRef)}` : "";
      return getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/activity${search}`,
        workspaceActivityDataSchema,
      );
    },
    async getToolCall(workspaceId, callId) {
      const result = await getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/tool-calls/${callId}`,
        workspaceToolCallDataSchema,
      );
      return result.call;
    },
    getDiff(workspaceId, scope) {
      return getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/diff?${diffScopeSearch(scope)}`,
        workspaceDiffDataSchema,
      );
    },
    getRefs(workspaceId) {
      return getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/refs`,
        workspaceRefsDataSchema,
      );
    },
  };
}

async function getJson<T>(
  url: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Inspector request failed (${response.status}).`);
  }
  return schema.parse(await response.json());
}

function diffScopeSearch(scope: WorkspaceDiffScopeInput): string {
  const search = new URLSearchParams({ scope: scope.kind });
  switch (scope.kind) {
    case "review":
      search.set("review", scope.review_ref);
      break;
    case "working-tree":
      break;
    case "branch":
      if (scope.base_ref) search.set("base", scope.base_ref);
      break;
    case "compare":
      search.set("from", scope.from_ref);
      search.set("to", scope.to_ref);
      break;
  }
  return search.toString();
}
