import type { WorkspaceToolCall } from "./workspace-activity-store.js";

const ACTIVITY_GROUP_GAP_MS = 2 * 60 * 1000;

export interface WorkspaceActivityGroup {
  id: string;
  kind: "review" | "inferred";
  startedAt: string;
  completedAt?: string;
  reviewRef?: string;
  calls: WorkspaceToolCall[];
}

export function groupWorkspaceToolCalls(
  calls: ReadonlyArray<WorkspaceToolCall>,
): WorkspaceActivityGroup[] {
  const byConversation = new Map<string, WorkspaceToolCall[]>();
  for (const call of calls) {
    const key = call.conversationScopeId ?? "__unscoped__";
    const conversationCalls = byConversation.get(key) ?? [];
    conversationCalls.push(call);
    byConversation.set(key, conversationCalls);
  }

  const groups = [...byConversation.values()].flatMap(groupConversationCalls);
  return [...groups].sort((left, right) => {
    const timeOrder = right.startedAt.localeCompare(left.startedAt);
    if (timeOrder !== 0) return timeOrder;
    return (right.calls[0]?.id ?? 0) - (left.calls[0]?.id ?? 0);
  });
}

function groupConversationCalls(calls: WorkspaceToolCall[]): WorkspaceActivityGroup[] {
  const ordered = [...calls].sort((left, right) => {
    const timeOrder = left.startedAt.localeCompare(right.startedAt);
    return timeOrder !== 0 ? timeOrder : left.id - right.id;
  });
  const groups: WorkspaceActivityGroup[] = [];
  let current: WorkspaceToolCall[] = [];

  const flush = () => {
    if (current.length === 0) return;
    groups.push(toActivityGroup(current));
    current = [];
  };

  for (const call of ordered) {
    const previous = current.at(-1);
    if (previous && callStartedAfterGap(previous, call)) flush();

    current.push(call);
    if (isReviewBoundary(call)) flush();
  }

  flush();
  return groups;
}

function toActivityGroup(calls: WorkspaceToolCall[]): WorkspaceActivityGroup {
  const first = calls[0]!;
  const last = calls.at(-1)!;
  const reviewRef = isReviewBoundary(last) ? last.reviewRef : undefined;
  return {
    id: reviewRef ? `review:${reviewRef}` : `activity:${first.id}`,
    kind: reviewRef ? "review" : "inferred",
    startedAt: first.startedAt,
    ...(last.completedAt ? { completedAt: last.completedAt } : {}),
    ...(reviewRef ? { reviewRef } : {}),
    calls,
  };
}

function callStartedAfterGap(previous: WorkspaceToolCall, next: WorkspaceToolCall): boolean {
  const previousEnd = Date.parse(previous.completedAt ?? previous.startedAt);
  const nextStart = Date.parse(next.startedAt);
  return Number.isFinite(previousEnd)
    && Number.isFinite(nextStart)
    && nextStart - previousEnd > ACTIVITY_GROUP_GAP_MS;
}

function isReviewBoundary(call: WorkspaceToolCall): call is WorkspaceToolCall & { reviewRef: string } {
  return call.toolName === "show_changes" && typeof call.reviewRef === "string";
}
