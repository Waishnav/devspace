import type { App } from "@modelcontextprotocol/ext-apps";

export type ToolName =
  | "open_workspace"
  | "show_changes"
  | "apply_patch"
  | "exec_command"
  | "write_stdin"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export type PatchOperation = "add" | "update" | "delete" | "move";
export type ReviewFileType =
  | "change"
  | "rename-pure"
  | "rename-changed"
  | "new"
  | "deleted";

export interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  workspaceReused?: boolean;
  includeBootstrapContext?: boolean;
  mode?: "checkout" | "worktree";
  sourceRoot?: string;
  worktree?: {
    path?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    detached?: boolean;
    managed?: boolean;
  };
  status?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    operation?: PatchOperation;
    type?: ReviewFileType;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  agentProviders?: Array<{
    name?: string;
    available?: boolean;
    reason?: string;
    version?: string;
    minimumVersion?: string;
  }>;
  agents?: Array<{
    name?: string;
    description?: string;
    provider?: string;
    model?: string;
    thinking?: string;
    providerAvailable?: boolean;
    providerUnavailableReason?: string;
  }>;
  instruction?: string;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "show_changes" ||
    value === "apply_patch" ||
    value === "exec_command" ||
    value === "write_stdin" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash"
  );
}

export function isReadTool(tool: ToolName): boolean {
  return tool === "read";
}

export function isWriteTool(tool: ToolName): boolean {
  return tool === "write";
}

export function isEditTool(tool: ToolName): boolean {
  return tool === "edit";
}

export function isPatchTool(tool: ToolName): boolean {
  return tool === "apply_patch";
}

export function isSearchTool(tool: ToolName): boolean {
  return tool === "grep" || tool === "glob";
}

export function isShellTool(tool: ToolName): boolean {
  return tool === "bash" || tool === "exec_command" || tool === "write_stdin";
}

export function isReviewTool(tool: ToolName): boolean {
  return tool === "show_changes";
}

export function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

export function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (card.tool === "open_workspace") {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.agentProviders ?? 0) > 0 ||
      Number(card.summary?.agents ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.agentProviders?.length) ||
      Boolean(card.agents?.length) ||
      Boolean(card.worktree) ||
      Boolean(card.instruction)
    );
  }

  if (isReviewTool(card.tool)) return Boolean(card.files?.length || card.payload?.patch);
  if (isPatchTool(card.tool)) return Boolean(card.payload?.patch);

  return Boolean(card.payload);
}

export function isInitiallyExpandedCard(card: ToolResultCard): boolean {
  if (card.tool === "open_workspace") return isExpandableCard(card);
  if (isReviewTool(card.tool)) return isExpandableCard(card);
  if (isPatchTool(card.tool)) {
    return card.files?.length === 1 && isExpandableCard(card);
  }
  return false;
}
