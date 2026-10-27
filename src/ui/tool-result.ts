import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReviewFileType, ToolResultCard } from "./card-types.js";
import { optionalFields, isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "../json-value.js";
import type { JsonObject, JsonValue } from "../json-value.js";

export type DecodedToolResult =
  | { kind: "card"; card: ToolResultCard }
  | { kind: "review-reference"; workspaceId: string; reviewRef: string }
  | { kind: "invalid" };

export interface ChatGptToolGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}

export function decodeToolResult(result: CallToolResult): DecodedToolResult {
  const structured = asRecord(result.structuredContent);
  const metaCard = cardFields(asRecord(asRecord(result._meta)?.card));

  if (structured) {
    const workspaceId = stringField(structured.workspace_id);
    const reviewRef = stringField(structured.review_ref);

    if (workspaceId && reviewRef) {
      if (isCompleteReviewCard(metaCard)) {
        return {
          kind: "card",
          card: {
            ...metaCard,
            tool: "show_changes",
            workspaceId,
          },
        };
      }

      return { kind: "review-reference", workspaceId, reviewRef };
    }

    if (isJsonString(structured.patch) && Array.isArray(structured.files)) {
      const legacyCard = cardFields({
        ...structured,
        payload: { patch: structured.patch },
      });

      if (legacyCard) {
        return { kind: "card", card: { ...legacyCard, tool: "show_changes" } };
      }
    }

    const root = stringField(structured.root);
    const mode = workspaceMode(structured.mode);

    if (workspaceId && root && mode) {
      const structuredCard = structuredWorkspaceCardFields(structured) ?? {};

      return {
        kind: "card",
        card: {
          ...structuredCard,
          ...metaCard,
          tool: "open_workspace",
          workspaceId,
          root,
          mode,
          summary: metaCard?.summary ?? workspaceSummary(structuredCard),
        },
      };
    }
  }

  // Existing conversations created before reviewRef was added can still render
  // while the host supplies their live MCP Apps result metadata.
  if (metaCard?.workspaceId && (metaCard.files?.length || metaCard.payload?.patch)) {
    return { kind: "card", card: { ...metaCard, tool: "show_changes" } };
  }

  if (metaCard?.workspaceId && metaCard.root && metaCard.mode) {
    return { kind: "card", card: { ...metaCard, tool: "open_workspace" } };
  }

  return { kind: "invalid" };
}

function structuredWorkspaceCardFields(
  record: JsonObject | undefined,
): Partial<ToolResultCard> | undefined {
  if (!record) return undefined;
  const worktreeRecord = asRecord(record.worktree);

  return cardFields({
    root: record.root,
    mode: record.mode,
    sourceRoot: record.source_root,
    worktree: worktreeRecord
      ? {
          path: worktreeRecord.path,
          baseRef: worktreeRecord.base_ref,
          baseSha: worktreeRecord.base_sha,
          dirtySource: worktreeRecord.dirty_source,
          detached: worktreeRecord.detached,
          managed: worktreeRecord.managed,
      }
      : undefined,
    review: record.review,
    agentsFiles: record.agents_files,
    availableAgentsFiles: record.available_agents_files,
    skills: record.skills,
    agentProviders: record.agent_providers,
    agents: record.agents,
    instruction: record.instruction,
  });
}

function isCompleteReviewCard(
  card: Partial<ToolResultCard> | undefined,
): card is Partial<ToolResultCard> & {
  files: NonNullable<ToolResultCard["files"]>;
  payload: { patch: string };
  summary: JsonObject;
} {
  if (!card || !Array.isArray(card.files) || !isJsonString(card.payload?.patch)) {
    return false;
  }

  return numberField(card.summary?.files) !== undefined
    && numberField(card.summary?.additions) !== undefined
    && numberField(card.summary?.removals) !== undefined;
}

export function toolResultFromChatGptGlobals(
  globals: ChatGptToolGlobals | undefined,
): CallToolResult | undefined {
  if (!globals) return undefined;

  const responseMetadata = asRecord(globals.toolResponseMetadata);
  const metadataResult = mcpToolResult(globals.toolResponseMetadata);

  const structuredContent = asRecord(globals.toolOutput)
    ?? asRecord(metadataResult?.structuredContent);

  const resultMeta = asRecord(metadataResult?._meta)
    ?? directResultMeta(responseMetadata);

  if (!metadataResult && !structuredContent && !resultMeta) return undefined;

  return {
    ...(metadataResult ?? { content: [] }),
    ...optionalFields(structuredContent ? { structuredContent } : undefined),
    ...optionalFields(resultMeta ? { _meta: resultMeta } : undefined),
  // SAFETY: Boundary value already validated or constructed to match this type.
  } as CallToolResult;
}

function directResultMeta(
  metadata: JsonObject | undefined,
): JsonObject | undefined {
  if (!metadata) return undefined;

  return "card" in metadata ? metadata : undefined;
}

function mcpToolResult(value: JsonValue): CallToolResult | undefined {
  const metadata = asRecord(value);

  if (!metadata) return undefined;

  const direct = asRecord(metadata.mcp_tool_result);

  // SAFETY: Boundary value already validated or constructed to match this type.
  if (direct) return direct as CallToolResult;

  const callToolResult = asRecord(metadata.call_tool_result);
  const nested = asRecord(callToolResult?.mcp_tool_result);

  // SAFETY: Boundary value already validated or constructed to match this type.
  return nested ? nested as CallToolResult : undefined;
}

function cardFields(record: JsonObject | undefined): Partial<ToolResultCard> | undefined {
  if (!record) return undefined;

  const agentsFiles = arrayRecords(record.agentsFiles)?.map((item) => ({
    path: stringField(item.path),
    content: stringField(item.content),
  }));

  const availableAgentsFiles = arrayRecords(record.availableAgentsFiles)?.map((item) => ({
    path: stringField(item.path),
  }));

  const skills = arrayRecords(record.skills)?.map((item) => ({
    name: stringField(item.name),
    description: stringField(item.description),
    path: stringField(item.path),
  }));

  const agentProviders = arrayRecords(record.agentProviders)?.map((item) => ({
    id: stringField(item.id),
    model: stringField(item.model),
    effort: stringField(item.effort),
    note: stringField(item.note),
  }));

  const agents = arrayRecords(record.agents)?.map((item) => ({
    name: stringField(item.name),
    description: stringField(item.description),
    provider: stringField(item.provider),
    model: stringField(item.model),
    effort: stringField(item.effort),
  }));

  const files = arrayRecords(record.files)?.map((item) => ({
    path: stringField(item.path),
    previousPath: stringField(item.previousPath),
    type: reviewFileType(item.type),
    additions: numberField(item.additions),
    removals: numberField(item.removals),
  }));

  const worktreeRecord = asRecord(record.worktree);
  const reviewRecord = asRecord(record.review);
  const summary = asRecord(record.summary);
  const payloadRecord = asRecord(record.payload);

  return definedFields({
    workspaceId: stringField(record.workspaceId),
    path: stringField(record.path),
    root: stringField(record.root),
    workspaceReused: booleanField(record.workspaceReused),
    includeBootstrapContext: booleanField(record.includeBootstrapContext),
    mode: workspaceMode(record.mode),
    sourceRoot: stringField(record.sourceRoot),
    worktree: worktreeRecord
      ? {
          path: stringField(worktreeRecord.path),
          baseRef: stringField(worktreeRecord.baseRef),
          baseSha: stringField(worktreeRecord.baseSha),
          dirtySource: booleanField(worktreeRecord.dirtySource),
          detached: booleanField(worktreeRecord.detached),
          managed: booleanField(worktreeRecord.managed),
        }
      : undefined,
    review: reviewAvailability(reviewRecord),
    summary,
    files,
    payload: payloadRecord ? { patch: stringField(payloadRecord.patch) } : undefined,
    agentsFiles,
    availableAgentsFiles,
    skills,
    agentProviders,
    agents,
    instruction: stringField(record.instruction),
  });
}

function workspaceSummary(card: Partial<ToolResultCard>): JsonObject {
  return {
    mode: card.mode,
    agentsFiles: card.agentsFiles?.length ?? 0,
    availableAgentsFiles: card.availableAgentsFiles?.length ?? 0,
    skills: card.skills?.length ?? 0,
    agentProviders: card.agentProviders?.length ?? 0,
    agents: card.agents?.length ?? 0,
  };
}

function reviewAvailability(
  record: JsonObject | undefined,
): ToolResultCard["review"] {
  if (!record || !isJsonBoolean(record.available)) return undefined;

  if (record.available) return { available: true };
  const reason = stringField(record.reason);

  return reason ? { available: false, reason } : undefined;
}

function reviewFileType(value: JsonValue): ReviewFileType | undefined {
  return value === "change"
    || value === "rename-pure"
    || value === "rename-changed"
    || value === "new"
    || value === "deleted"
    ? value
    : undefined;
}

function workspaceMode(value: JsonValue): ToolResultCard["mode"] {
  return value === "checkout" || value === "worktree" ? value : undefined;
}

function arrayRecords(value: JsonValue): Array<JsonObject> | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item) => {
    const record = asRecord(item);

    return record ? [record] : [];
  });
}

function asRecord(value: JsonValue): JsonObject | undefined {
  return value !== null && isJsonObject(value)
    // SAFETY: Boundary value already validated or constructed to match this type.
    ? value as JsonObject
    : undefined;
}

function stringField(value: JsonValue): string | undefined {
  return isJsonString(value) ? value : undefined;
}

function numberField(value: JsonValue): number | undefined {
  return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: JsonValue): boolean | undefined {
  return isJsonBoolean(value) ? value : undefined;
}

function definedFields<T extends JsonObject>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  // SAFETY: Boundary value already validated or constructed to match this type.
  ) as T;
}
