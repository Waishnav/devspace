import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { WorkspaceActivityStore } from "./workspace-activity-store.js";

type ToolHandlerExtra = {
  _meta?: Record<string, unknown>;
  requestId?: unknown;
};

export class WorkspaceActivityJournal {
  private readonly store: WorkspaceActivityStore;

  constructor(
    stateDir: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.store = new WorkspaceActivityStore(stateDir);
  }

  async capture<T>(input: {
    toolName: string;
    arguments: unknown;
    extra: ToolHandlerExtra;
    operation: () => Promise<T>;
  }): Promise<T> {
    if (isHistoricalReviewReplay(input.toolName, input.extra._meta)) {
      return input.operation();
    }

    const startedAt = new Date();
    const startedAtMs = performance.now();
    const argumentWorkspaceId = workspaceIdFromValue(input.arguments);
    let callId: number | undefined;

    try {
      callId = this.store.startCall({
        workspaceId: argumentWorkspaceId,
        conversationScopeId: conversationScopeIdFromRequestMeta(input.extra._meta),
        requestId: requestIdFromExtra(input.extra.requestId),
        toolName: input.toolName,
        arguments: input.arguments,
        startedAt: startedAt.toISOString(),
      });
    } catch (error) {
      this.onError(error);
    }

    try {
      const result = await input.operation();
      if (callId !== undefined) {
        this.finishSafely(callId, {
          workspaceId: workspaceIdFromValue(result) ?? argumentWorkspaceId,
          result,
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAtMs),
          reviewRef: reviewRefFromValue(result),
        });
      }
      return result;
    } catch (error) {
      if (callId !== undefined) {
        this.finishSafely(callId, {
          workspaceId: argumentWorkspaceId,
          error: serializeError(error),
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAtMs),
        });
      }
      throw error;
    }
  }

  close(): void {
    this.store.close();
  }

  private finishSafely(
    callId: number,
    input: Parameters<WorkspaceActivityStore["finishCall"]>[1],
  ): void {
    try {
      this.store.finishCall(callId, input);
    } catch (error) {
      this.onError(error);
    }
  }
}

function workspaceIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = record?.workspace_id;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const structured = asRecord(record?.structuredContent);
  const nested = structured?.workspace_id;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function reviewRefFromValue(value: unknown): string | undefined {
  const structured = asRecord(asRecord(value)?.structuredContent);
  const reviewRef = structured?.review_ref;
  return typeof reviewRef === "string" && reviewRef.length > 0 ? reviewRef : undefined;
}

function requestIdFromExtra(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isHistoricalReviewReplay(
  toolName: string,
  meta: Record<string, unknown> | undefined,
): boolean {
  return toolName === "show_changes" && typeof meta?.["devspace/reviewRef"] === "string";
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: typeof error, message: String(error) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
