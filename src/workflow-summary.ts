import type { WorkflowRunScope, WorkflowStore } from "./workflow-store.js";
import type { WorkflowRunStatus } from "./workflow-types.js";

const ACTIVE_WORKFLOW_STATUSES = ["starting", "running"] as const satisfies readonly WorkflowRunStatus[];
type ActiveWorkflowStatus = (typeof ACTIVE_WORKFLOW_STATUSES)[number];

export interface ActiveWorkflowSummary {
  id: string;
  name: string;
  status: ActiveWorkflowStatus;
  calls: {
    running: number;
    completed: number;
    failed: number;
  };
}

export function loadActiveWorkflowSummaries(
  store: WorkflowStore,
  scope: WorkflowRunScope,
): ActiveWorkflowSummary[] {
  return store
    .listRunsForScope(scope, {
      statuses: [...ACTIVE_WORKFLOW_STATUSES],
      limit: 50,
    })
    .flatMap((run) => {
      if (run.status !== "starting" && run.status !== "running") return [];
      const calls = store.listAgentCalls(run.id);
      return [{
        id: run.id,
        name: run.name,
        status: run.status,
        calls: {
          running: calls.filter((call) => call.status === "running").length,
          completed: calls.filter((call) =>
            call.status === "completed" || call.status === "from_cache"
          ).length,
          failed: calls.filter((call) => call.status === "failed").length,
        },
      }];
    });
}
