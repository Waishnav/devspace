import { resolve } from "node:path";
import { parseWorkflowEventPayload } from "./workflow-contracts.js";
import type { WorkflowStore } from "./workflow-store.js";
import type {
  WorkflowAgentCallRecord,
  WorkflowAgentCallStatus,
  WorkflowErrorKind,
  WorkflowEventRecord,
  WorkflowEventType,
  WorkflowRunRecord,
  WorkflowRunSource,
  WorkflowRunStatus,
  WorkflowTokenUsage,
  WorkflowAgentActivityRecord,
} from "./workflow-types.js";

export const ACTIVE_WORKFLOW_STATUSES = ["starting", "running"] as const satisfies readonly WorkflowRunStatus[];

export interface WorkflowCallCounts {
  running: number;
  completed: number;
  cached: number;
  failed: number;
  cancelled: number;
  observed: number;
}

export interface WorkflowCallView {
  callIndex: number;
  status: WorkflowAgentCallStatus;
  provider: string;
  model?: string;
  effort?: string;
  label?: string;
  phase?: string;
  isolation: "shared" | "worktree";
  worktreePath?: string;
  dirty?: boolean;
  fromCache: boolean;
  replayMatch?: "same_index";
  replayedFromRunId?: string;
  replayedFromCallIndex?: number;
  replayReason?: string;
  error?: string;
  errorKind?: WorkflowErrorKind;
  providerSessionId?: string;
  usage?: WorkflowTokenUsage;
  prompt: string;
  responseText?: string;
  structuredJson?: string;
  returnValueJson?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface WorkflowPhaseView {
  title: string;
  detail?: string;
  status: "not_started" | "running" | "completed" | "failed" | "cancelled";
  calls: WorkflowCallView[];
}

export interface WorkflowActivityView {
  seq: number;
  type: WorkflowEventType;
  phase?: string;
  label?: string;
  detail?: string;
  createdAt: string;
}

export interface WorkflowRunView {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  source: WorkflowRunSource;
  scriptPath: string;
  scriptHash: string;
  workspaceRoot: string;
  resumedFromRunId?: string;
  currentPhase?: string;
  calls: WorkflowCallCounts;
  totalTokens: number;
  phases: WorkflowPhaseView[];
  unphasedCalls: WorkflowCallView[];
  recentActivity: WorkflowActivityView[];
  latestEventSeq: number;
  version: string;
  error?: string;
  errorKind?: WorkflowErrorKind;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface WorkflowProjectView {
  workspaceRoot: string;
  runs: WorkflowRunView[];
  version: string;
}

export interface WorkflowCallInspectorView {
  run: WorkflowRunView;
  call: WorkflowCallView;
  activity: WorkflowAgentActivityRecord[];
}

export function loadWorkflowProjectView(
  store: WorkflowStore,
  workspaceRoot: string,
  options: {
    statuses?: WorkflowRunStatus[];
    limit?: number;
    eventLimit?: number;
  } = {},
): WorkflowProjectView {
  const root = resolve(workspaceRoot);
  const runs = store
    .listRunsForWorkspace(root, {
      statuses: options.statuses,
      limit: options.limit,
    })
    .map((run) =>
      buildWorkflowRunView(
        run,
        store.listAgentCalls(run.id),
        store.listEvents(run.id, options.eventLimit ?? 100),
      ),
    );

  return {
    workspaceRoot: root,
    runs,
    version: runs.map((run) => `${run.id}:${run.version}`).join("|"),
  };
}

export function buildWorkflowRunView(
  run: WorkflowRunRecord,
  calls: WorkflowAgentCallRecord[],
  events: WorkflowEventRecord[],
): WorkflowRunView {
  const callViews = calls.map(toCallView);
  const phaseOrder: string[] = [];
  let currentPhase: string | undefined;

  for (const event of events) {
    if (event.type !== "phase_started") continue;
    const title = event.phase ?? parsePhaseTitle(event);
    if (!title) continue;
    currentPhase = title;
    if (!phaseOrder.includes(title)) phaseOrder.push(title);
  }
  for (const call of callViews) {
    if (call.phase && !phaseOrder.includes(call.phase)) phaseOrder.push(call.phase);
  }

  const declaredPhases = run.phases ?? [];
  for (const phase of declaredPhases) {
    if (!phaseOrder.includes(phase.title)) phaseOrder.push(phase.title);
  }
  phaseOrder.sort((left, right) => {
    const leftDeclared = declaredPhases.findIndex((phase) => phase.title === left);
    const rightDeclared = declaredPhases.findIndex((phase) => phase.title === right);
    if (leftDeclared < 0 && rightDeclared < 0) return 0;
    if (leftDeclared < 0) return 1;
    if (rightDeclared < 0) return -1;
    return leftDeclared - rightDeclared;
  });
  const currentPhaseIndex = currentPhase ? phaseOrder.indexOf(currentPhase) : -1;
  const phases = phaseOrder.map((title, index) => ({
    title,
    detail: declaredPhases.find((phase) => phase.title === title)?.detail,
    status: phaseStatus(run.status, index, currentPhaseIndex),
    calls: callViews.filter((call) => call.phase === title),
  }));
  const latestEventSeq = events.at(-1)?.seq ?? 0;
  const latestCallUpdate = calls.reduce(
    (latest, call) => call.updatedAt > latest ? call.updatedAt : latest,
    run.updatedAt,
  );

  return {
    id: run.id,
    name: run.name,
    status: run.status,
    source: run.source,
    scriptPath: run.scriptPath,
    scriptHash: run.scriptHash,
    workspaceRoot: run.workspaceRoot,
    resumedFromRunId: run.resumedFromRunId,
    currentPhase,
    calls: countCalls(callViews),
    totalTokens: callViews.reduce(
      (total, call) => total + (call.fromCache ? 0 : call.usage?.totalTokens ?? 0),
      0,
    ),
    phases,
    unphasedCalls: callViews.filter((call) => !call.phase),
    recentActivity: events.map(toActivityView),
    latestEventSeq,
    version: `${run.updatedAt}:${latestCallUpdate}:${latestEventSeq}`,
    error: run.error,
    errorKind: run.errorKind,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
  };
}

function toCallView(call: WorkflowAgentCallRecord): WorkflowCallView {
  return {
    callIndex: call.callIndex,
    status: call.status,
    provider: call.provider,
    model: call.model,
    effort: call.effort,
    label: call.label,
    phase: call.phase,
    isolation: call.isolation,
    worktreePath: call.worktreePath,
    dirty: call.dirty,
    fromCache: call.fromCache,
    replayMatch: call.replayMatch,
    replayedFromRunId: call.replayedFromRunId,
    replayedFromCallIndex: call.replayedFromCallIndex,
    replayReason: call.replayReason,
    error: call.error,
    errorKind: call.errorKind,
    providerSessionId: call.providerSessionId,
    usage: call.usage,
    prompt: call.prompt,
    responseText: call.responseText,
    structuredJson: call.structuredJson,
    returnValueJson: call.returnValueJson,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    updatedAt: call.updatedAt,
  };
}

function phaseStatus(
  runStatus: WorkflowRunStatus,
  index: number,
  currentIndex: number,
): WorkflowPhaseView["status"] {
  if (currentIndex < 0) {
    return runStatus === "completed" ? "completed" : "not_started";
  }
  if (index < currentIndex) return "completed";
  if (index > currentIndex) return "not_started";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  if (runStatus === "completed") return "completed";
  return "running";
}

function countCalls(calls: WorkflowCallView[]): WorkflowCallCounts {
  const counts: WorkflowCallCounts = {
    running: 0,
    completed: 0,
    cached: 0,
    failed: 0,
    cancelled: 0,
    observed: calls.length,
  };
  for (const call of calls) {
    if (call.status === "running") counts.running += 1;
    else if (call.status === "completed") counts.completed += 1;
    else if (call.status === "from_cache") counts.cached += 1;
    else if (call.status === "failed") counts.failed += 1;
    else if (call.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

function toActivityView(event: WorkflowEventRecord): WorkflowActivityView {
  return {
    seq: event.seq,
    type: event.type,
    phase: event.phase,
    label: event.label,
    detail: activityDetail(event),
    createdAt: event.createdAt,
  };
}

function activityDetail(event: WorkflowEventRecord): string | undefined {
  try {
    if (event.type === "log") {
      return parseWorkflowEventPayload("log", JSON.parse(event.dataJson) as unknown).message;
    }
    if (event.type === "agent_call_failed") {
      return parseWorkflowEventPayload(
        "agent_call_failed",
        JSON.parse(event.dataJson) as unknown,
      ).error;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parsePhaseTitle(event: WorkflowEventRecord): string | undefined {
  try {
    return parseWorkflowEventPayload(
      "phase_started",
      JSON.parse(event.dataJson) as unknown,
    ).title;
  } catch {
    return undefined;
  }
}
