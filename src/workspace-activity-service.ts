import { groupWorkspaceToolCalls, type WorkspaceActivityGroup } from "./workspace-activity.js";
import {
  WorkspaceActivityStore,
  type WorkspaceToolCall,
  type WorkspaceToolCallSummary,
} from "./workspace-activity-store.js";

const DEFAULT_ACTIVITY_CALL_LIMIT = 250;

export interface WorkspaceActivitySnapshot {
  groups: WorkspaceActivityGroup[];
}

export class WorkspaceActivityService {
  private readonly store: WorkspaceActivityStore;

  constructor(stateDir: string) {
    this.store = new WorkspaceActivityStore(stateDir);
  }

  listActivity(workspaceId: string, limit = DEFAULT_ACTIVITY_CALL_LIMIT): WorkspaceActivitySnapshot {
    const calls = this.store.listCallSummaries({ workspaceId, limit });
    return { groups: groupWorkspaceToolCalls(calls) };
  }

  getToolCall(workspaceId: string, callId: number): WorkspaceToolCall | undefined {
    return this.store.getCall(workspaceId, callId);
  }

  findReviewGroup(workspaceId: string, reviewRef: string): WorkspaceActivityGroup | undefined {
    const boundary = this.store.findCallSummaryByReviewRef(workspaceId, reviewRef);
    if (!boundary) return undefined;

    const preceding = this.store.listCallSummaries({
      workspaceId,
      beforeId: boundary.id,
      limit: DEFAULT_ACTIVITY_CALL_LIMIT,
    });
    return groupWorkspaceToolCalls([boundary, ...preceding])
      .find((group) => group.reviewRef === reviewRef);
  }

  close(): void {
    this.store.close();
  }
}

export function toolCallState(call: WorkspaceToolCallSummary): "running" | "completed" {
  return call.completedAt ? "completed" : "running";
}
