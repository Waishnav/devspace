import { resolve } from "node:path";
import { parseWorkflowEventPayload } from "./workflow-contracts.js";
import type { WorkflowStore } from "./workflow-store.js";
import type {
  LocalAgentTokenUsage,
  WorkflowAgentCallRecord,
  WorkflowAgentCallStatus,
  WorkflowAgentObservationRecord,
  WorkflowErrorKind,
  WorkflowEventRecord,
  WorkflowEventType,
  WorkflowRunRecord,
  WorkflowRunSource,
  WorkflowRunStatus,
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

export type WorkflowPhaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowObservationView {
  seq: number;
  kind: "activity" | "usage";
  activityId?: string;
  message?: string;
  toolName?: string;
  toolStatus?: "started" | "updated" | "completed" | "failed";
  detail?: string;
  usage?: LocalAgentTokenUsage;
  createdAt: string;
}

export interface WorkflowCallView {
  callIndex: number;
  status: WorkflowAgentCallStatus;
  provider: string;
  model?: string;
  effort?: string;
  profileName?: string;
  label?: string;
  phase?: string;
  prompt: string;
  responseText?: string;
  providerSessionId?: string;
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
  usage?: LocalAgentTokenUsage;
  finalUsage?: LocalAgentTokenUsage;
  observations: WorkflowObservationView[];
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface WorkflowPhaseView {
  title: string;
  status: WorkflowPhaseStatus;
  calls: WorkflowCallView[];
  usage?: LocalAgentTokenUsage;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
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
  usage?: LocalAgentTokenUsage;
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

export function loadWorkflowProjectView(
  store: WorkflowStore,
  workspaceRoot: string,
  options: {
    statuses?: WorkflowRunStatus[];
    limit?: number;
    eventLimit?: number;
    observationLimit?: number;
  } = {},
): WorkflowProjectView {
  const root = resolve(workspaceRoot);
  const runs = store
    .listRunsForWorkspace(root, {
      statuses: options.statuses,
      limit: options.limit,
    })
    .map((run) => {
      const calls = store.listAgentCalls(run.id);
      const observations = new Map(
        calls.map((call) => [
          call.callIndex,
          store.listAgentObservations(run.id, call.callIndex, options.observationLimit ?? 100),
        ]),
      );
      return buildWorkflowRunView(
        run,
        calls,
        store.listEvents(run.id, options.eventLimit ?? 100),
        observations,
      );
    });

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
  observations = new Map<number, WorkflowAgentObservationRecord[]>(),
): WorkflowRunView {
  const callViews = calls.map((call) =>
    toCallView(call, observations.get(call.callIndex) ?? []),
  );
  const phaseOrder: string[] = [];
  const phaseMeta = new Map<string, { startedAt?: string; completedAt?: string; status: WorkflowPhaseStatus }>();
  let currentPhase: string | undefined;

  for (const event of events) {
    if (event.type !== "phase_started") continue;
    const title = event.phase ?? parsePhaseTitle(event);
    if (!title) continue;
    if (currentPhase && currentPhase !== title) {
      const previous = phaseMeta.get(currentPhase);
      if (previous?.status === "running") {
        previous.status = "completed";
        previous.completedAt = event.createdAt;
      }
    }
    currentPhase = title;
    if (!phaseOrder.includes(title)) phaseOrder.push(title);
    phaseMeta.set(title, {
      startedAt: phaseMeta.get(title)?.startedAt ?? event.createdAt,
      status: "running",
    });
  }
  for (const call of callViews) {
    if (call.phase && !phaseOrder.includes(call.phase)) phaseOrder.push(call.phase);
  }

  const phases = phaseOrder.map((title) => {
    const phaseCalls = callViews.filter((call) => call.phase === title);
    const meta = phaseMeta.get(title);
    const status = phaseStatus(run.status, meta?.status, phaseCalls);
    const completedAt = meta?.completedAt ?? (isTerminalRun(run.status) ? run.completedAt : undefined);
    return {
      title,
      status,
      calls: phaseCalls,
      usage: sumUsage(phaseCalls.map((call) => call.finalUsage ?? call.usage)),
      startedAt: meta?.startedAt ?? phaseCalls[0]?.startedAt,
      completedAt,
      durationMs: elapsedMs(meta?.startedAt ?? phaseCalls[0]?.startedAt, completedAt),
    };
  });

  const latestEventSeq = events.at(-1)?.seq ?? 0;
  const latestCallUpdate = calls.reduce(
    (latest, call) => call.updatedAt > latest ? call.updatedAt : latest,
    run.updatedAt,
  );
  const latestObservation = callViews
    .flatMap((call) => call.observations)
    .at(-1)?.createdAt;

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
    usage: sumUsage(callViews.map((call) => call.finalUsage ?? call.usage)),
    phases,
    unphasedCalls: callViews.filter((call) => !call.phase),
    recentActivity: events.map(toActivityView),
    latestEventSeq,
    version: `${run.updatedAt}:${latestCallUpdate}:${latestObservation ?? ""}:${latestEventSeq}`,
    error: run.error,
    errorKind: run.errorKind,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
  };
}

function toCallView(
  call: WorkflowAgentCallRecord,
  observations: WorkflowAgentObservationRecord[],
): WorkflowCallView {
  return {
    callIndex: call.callIndex,
    status: call.status,
    provider: call.provider,
    model: call.model,
    effort: call.effort,
    profileName: call.profileName,
    label: call.label,
    phase: call.phase,
    prompt: call.prompt,
    responseText: call.responseText,
    providerSessionId: call.providerSessionId,
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
    usage: call.usage,
    finalUsage: call.finalUsage,
    observations: observations.map(toObservationView),
    durationMs: elapsedMs(call.startedAt, call.completedAt),
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    updatedAt: call.updatedAt,
  };
}

function toObservationView(observation: WorkflowAgentObservationRecord): WorkflowObservationView {
  return {
    seq: observation.seq,
    kind: observation.kind,
    activityId: observation.activityId,
    message: observation.message,
    toolName: observation.toolName,
    toolStatus: observation.toolStatus,
    detail: observation.detail,
    usage: observation.usage,
    createdAt: observation.createdAt,
  };
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

function phaseStatus(
  runStatus: WorkflowRunStatus,
  inferred: WorkflowPhaseStatus | undefined,
  calls: WorkflowCallView[],
): WorkflowPhaseStatus {
  if (calls.some((call) => call.status === "failed")) return "failed";
  if (calls.some((call) => call.status === "cancelled")) return "cancelled";
  if (calls.some((call) => call.status === "running")) return "running";
  if (inferred === "running" && !isTerminalRun(runStatus)) return "running";
  if (calls.length > 0 && calls.every((call) =>
    call.status === "completed" || call.status === "from_cache"
  )) return "completed";
  return inferred ?? "pending";
}

function isTerminalRun(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sumUsage(usages: Array<LocalAgentTokenUsage | undefined>): LocalAgentTokenUsage | undefined {
  const present = usages.filter((usage): usage is LocalAgentTokenUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  const sum = (key: keyof LocalAgentTokenUsage): number | undefined => {
    const values = present.map((usage) => usage[key]).filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const result: LocalAgentTokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const value = sum(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function elapsedMs(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt) return undefined;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
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
