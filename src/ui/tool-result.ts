import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResultCard } from "./card-types.js";

const optionalStringSchema = z.string().optional().catch(undefined);

const optionalNumberSchema = z.number().finite().optional().catch(undefined);

const optionalBooleanSchema = z.boolean().optional().catch(undefined);

const optionalModeSchema = z
  .enum(["checkout", "worktree"])
  .optional()
  .catch(undefined);

const optionalReviewFileTypeSchema = z
  .enum([
    "change",
    "rename-pure",
    "rename-changed",
    "new",
    "deleted",
  ])
  .optional()
  .catch(undefined);

const fileSchema = z
  .object({
    path: optionalStringSchema,
    previousPath: optionalStringSchema,
    previous_path: optionalStringSchema,
    type: optionalReviewFileTypeSchema,
    additions: optionalNumberSchema,
    removals: optionalNumberSchema,
  })
  .passthrough();

const worktreeSchema = z
  .object({
    path: optionalStringSchema,
    baseRef: optionalStringSchema,
    baseSha: optionalStringSchema,
    dirtySource: optionalBooleanSchema,
    detached: optionalBooleanSchema,
    managed: optionalBooleanSchema,
    base_ref: optionalStringSchema,
    base_sha: optionalStringSchema,
    dirty_source: optionalBooleanSchema,
  })
  .passthrough();

const reviewSchema = z
  .object({
    available: optionalBooleanSchema,
    reason: optionalStringSchema,
  })
  .passthrough();

const summaryExtensionSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const summarySchema = z
  .object({
    mode: optionalModeSchema,
    files: optionalNumberSchema,
    additions: optionalNumberSchema,
    removals: optionalNumberSchema,
    agentsFiles: optionalNumberSchema,
    availableAgentsFiles: optionalNumberSchema,
    skills: optionalNumberSchema,
    agentProviders: optionalNumberSchema,
    agents: optionalNumberSchema,
  })
  .catchall(summaryExtensionSchema);

const payloadSchema = z
  .object({
    patch: optionalStringSchema,
  })
  .passthrough();

const agentsFileSchema = z
  .object({
    path: optionalStringSchema,
    content: optionalStringSchema,
  })
  .passthrough();

const availableAgentsFileSchema = z
  .object({
    path: optionalStringSchema,
  })
  .passthrough();

const skillSchema = z
  .object({
    name: optionalStringSchema,
    description: optionalStringSchema,
    path: optionalStringSchema,
  })
  .passthrough();

const agentProviderSchema = z
  .object({
    id: optionalStringSchema,
    model: optionalStringSchema,
    effort: optionalStringSchema,
    note: optionalStringSchema,
  })
  .passthrough();

const agentSchema = z
  .object({
    name: optionalStringSchema,
    description: optionalStringSchema,
    provider: optionalStringSchema,
    model: optionalStringSchema,
    effort: optionalStringSchema,
  })
  .passthrough();

const toolRecordSchema = z
  .object({
    workspace_id: optionalStringSchema,
    review_ref: optionalStringSchema,
    patch: optionalStringSchema,
    result: optionalStringSchema,
    files: z.array(fileSchema.optional().catch(undefined)).optional().catch(undefined),
    root: optionalStringSchema,
    mode: optionalModeSchema,
    source_root: optionalStringSchema,
    worktree: worktreeSchema.optional().catch(undefined),
    review: reviewSchema.optional().catch(undefined),
    agents_files: z.array(agentsFileSchema.optional().catch(undefined)).optional().catch(undefined),
    available_agents_files: z.array(availableAgentsFileSchema.optional().catch(undefined)).optional().catch(undefined),
    skills: z.array(skillSchema.optional().catch(undefined)).optional().catch(undefined),
    agent_providers: z.array(agentProviderSchema.optional().catch(undefined)).optional().catch(undefined),
    agents: z.array(agentSchema.optional().catch(undefined)).optional().catch(undefined),
    workspaceId: optionalStringSchema,
    reviewRef: optionalStringSchema,
    path: optionalStringSchema,
    workspaceReused: optionalBooleanSchema,
    includeBootstrapContext: optionalBooleanSchema,
    sourceRoot: optionalStringSchema,
    agentsFiles: z.array(agentsFileSchema.optional().catch(undefined)).optional().catch(undefined),
    availableAgentsFiles: z.array(availableAgentsFileSchema.optional().catch(undefined)).optional().catch(undefined),
    agentProviders: z.array(agentProviderSchema.optional().catch(undefined)).optional().catch(undefined),
    instruction: optionalStringSchema,
    summary: summarySchema.optional().catch(undefined),
    payload: payloadSchema.optional().catch(undefined),
  })
  .passthrough();

type ToolRecord = z.infer<typeof toolRecordSchema>;

type ParsedSummary = z.infer<typeof summarySchema>;

type ParsedCard = Omit<Partial<ToolResultCard>, "summary"> & {
  summary?: ParsedSummary;
};

export type DecodedToolResult =
  | { kind: "card"; card: ToolResultCard }
  | { kind: "review-reference"; workspaceId: string; reviewRef: string }
  | { kind: "invalid" };

export interface ChatGptToolGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}

export function decodeToolResult(result: CallToolResult): DecodedToolResult {
  const structuredResult = toolRecordSchema.safeParse(result.structuredContent);
  const structured = structuredResult.success ? structuredResult.data : undefined;
  const cardResult = toolRecordSchema.safeParse(result._meta?.card);
  const metaCard = cardFields(cardResult.success ? cardResult.data : undefined);

  if (structured) {
    const workspaceId = structured.workspace_id ?? structured.workspaceId;
    const reviewRef = structured.review_ref ?? structured.reviewRef;

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

    if (structured.patch !== undefined && structured.files !== undefined) {
      const legacyCard = cardFields({
        ...structured,
        payload: { patch: structured.patch },
      });

      if (legacyCard) {
        return { kind: "card", card: { ...legacyCard, tool: "show_changes" } };
      }
    }

    const root = structured.root;
    const mode = structured.mode;

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
  record: ToolRecord | undefined,
): ParsedCard | undefined {
  if (!record) return undefined;
  const worktreeRecord = record.worktree;

  return cardFields({
    root: record.root,
    mode: record.mode,
    sourceRoot: record.source_root ?? record.sourceRoot,
    worktree: worktreeRecord
      ? {
          path: worktreeRecord.path,
          baseRef: worktreeRecord.base_ref ?? worktreeRecord.baseRef,
          baseSha: worktreeRecord.base_sha ?? worktreeRecord.baseSha,
          dirtySource: worktreeRecord.dirty_source ?? worktreeRecord.dirtySource,
          detached: worktreeRecord.detached,
          managed: worktreeRecord.managed,
        }
      : undefined,
    review: record.review,
    agentsFiles: record.agents_files ?? record.agentsFiles,
    availableAgentsFiles: record.available_agents_files ?? record.availableAgentsFiles,
    skills: record.skills,
    agentProviders: record.agent_providers ?? record.agentProviders,
    agents: record.agents,
    instruction: record.instruction,
  });
}

function isCompleteReviewCard(
  card: ParsedCard | undefined,
): card is ParsedCard & {
  files: NonNullable<ToolResultCard["files"]>;
  payload: { patch: string };
  summary: ParsedSummary;
} {
  if (!card?.files || card.payload?.patch === undefined || !card.summary) {
    return false;
  }

  return card.summary.files !== undefined
    && card.summary.additions !== undefined
    && card.summary.removals !== undefined;
}

export function toolResultFromChatGptGlobals(
  globals: ChatGptToolGlobals | undefined,
): CallToolResult | undefined {
  if (!globals) return undefined;

  const responseMetadataResult = toolRecordSchema.safeParse(globals.toolResponseMetadata);

  const responseMetadata = responseMetadataResult.success
    ? responseMetadataResult.data
    : undefined;

  const responseResult = mcpToolResultSchema.safeParse(globals.toolResponseMetadata);

  const metadataResult = responseResult.success
    ? mcpToolResult(responseResult.data)
    : undefined;

  const outputResult = toolRecordSchema.safeParse(globals.toolOutput);

  const outputStructuredContent = outputResult.success ? outputResult.data : undefined;

  const metadataStructuredResult = toolRecordSchema.safeParse(metadataResult?.structuredContent);

  const metadataStructuredContent = metadataStructuredResult.success
    ? metadataStructuredResult.data
    : undefined;

  const structuredContent = outputStructuredContent ?? metadataStructuredContent;

  const metadataMetaResult = toolRecordSchema.safeParse(metadataResult?._meta);

  const metadataMeta = metadataMetaResult.success ? metadataMetaResult.data : undefined;

  const resultMeta = metadataMeta ?? directResultMeta(responseMetadata);

  if (!metadataResult && !structuredContent && !resultMeta) return undefined;

  const result: CallToolResult = metadataResult
    ? { ...metadataResult }
    : { content: [] };

  if (structuredContent) result.structuredContent = structuredContent;

  if (resultMeta) result._meta = resultMeta;

  return result;
}

function directResultMeta(
  metadata: ToolRecord | undefined,
): ToolRecord | undefined {
  if (!metadata) return undefined;

  return "card" in metadata ? metadata : undefined;
}

const optionalCallToolResultSchema = CallToolResultSchema.optional().catch(undefined);

const mcpToolResultSchema = z
  .object({
    mcp_tool_result: optionalCallToolResultSchema,
    call_tool_result: z
      .object({
        mcp_tool_result: optionalCallToolResultSchema,
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

type McpToolResultMetadata = z.infer<typeof mcpToolResultSchema>;

function mcpToolResult(
  metadata: McpToolResultMetadata,
): CallToolResult | undefined {
  return metadata.mcp_tool_result
    ?? metadata.call_tool_result?.mcp_tool_result;
}

function cardFields(record: ToolRecord | undefined): ParsedCard | undefined {
  if (!record) return undefined;

  const agentsFiles = record.agentsFiles?.flatMap((item) => item
    ? [{
        path: item.path,
        content: item.content,
      }]
    : []);

  const availableAgentsFiles = record.availableAgentsFiles?.flatMap((item) => item
    ? [{
        path: item.path,
      }]
    : []);

  const skills = record.skills?.flatMap((item) => item
    ? [{
        name: item.name,
        description: item.description,
        path: item.path,
      }]
    : []);

  const agentProviders = record.agentProviders?.flatMap((item) => item
    ? [{
        id: item.id,
        model: item.model,
        effort: item.effort,
        note: item.note,
      }]
    : []);

  const agents = record.agents?.flatMap((item) => item
    ? [{
        name: item.name,
        description: item.description,
        provider: item.provider,
        model: item.model,
        effort: item.effort,
      }]
    : []);

  const files = record.files?.flatMap((item) => item
    ? [{
        path: item.path,
        previousPath: item.previousPath ?? item.previous_path,
        type: item.type,
        additions: item.additions,
        removals: item.removals,
      }]
    : []);

  const worktreeRecord = record.worktree;
  const reviewRecord = record.review;
  const summary = record.summary;
  const payloadRecord = record.payload;

  const card: ParsedCard = {};

  if (record.workspaceId !== undefined) card.workspaceId = record.workspaceId;

  if (record.path !== undefined) card.path = record.path;

  if (record.root !== undefined) card.root = record.root;

  if (record.workspaceReused !== undefined) card.workspaceReused = record.workspaceReused;

  if (record.includeBootstrapContext !== undefined) {
    card.includeBootstrapContext = record.includeBootstrapContext;
  }

  if (record.mode !== undefined) card.mode = record.mode;

  if (record.sourceRoot !== undefined) card.sourceRoot = record.sourceRoot;

  if (worktreeRecord !== undefined) {
    card.worktree = {
      path: worktreeRecord.path,
      baseRef: worktreeRecord.baseRef,
      baseSha: worktreeRecord.baseSha,
      dirtySource: worktreeRecord.dirtySource,
      detached: worktreeRecord.detached,
      managed: worktreeRecord.managed,
    };
  }

  const review = reviewAvailability(reviewRecord);

  if (review !== undefined) card.review = review;

  if (summary !== undefined) card.summary = summary;

  if (files !== undefined) card.files = files;

  if (payloadRecord !== undefined) card.payload = { patch: payloadRecord.patch };

  if (agentsFiles !== undefined) card.agentsFiles = agentsFiles;

  if (availableAgentsFiles !== undefined) card.availableAgentsFiles = availableAgentsFiles;

  if (skills !== undefined) card.skills = skills;

  if (agentProviders !== undefined) card.agentProviders = agentProviders;

  if (agents !== undefined) card.agents = agents;

  if (record.instruction !== undefined) card.instruction = record.instruction;

  return card;
}

function workspaceSummary(card: ParsedCard): ParsedSummary {
  const summary: ParsedSummary = {
    agentsFiles: card.agentsFiles?.length ?? 0,
    availableAgentsFiles: card.availableAgentsFiles?.length ?? 0,
    skills: card.skills?.length ?? 0,
    agentProviders: card.agentProviders?.length ?? 0,
    agents: card.agents?.length ?? 0,
  };

  if (card.mode !== undefined) summary.mode = card.mode;

  return summary;
}

function reviewAvailability(
  record: ToolRecord["review"],
): ToolResultCard["review"] {
  if (!record || (record.available !== true && record.available !== false)) return undefined;

  if (record.available) return { available: true };
  const reason = record.reason;

  return reason ? { available: false, reason } : undefined;
}
