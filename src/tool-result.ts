export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse<TDetails = unknown> {
  content: ToolContent[];
  details?: TDetails;
  isError?: boolean;
}

export interface ToolResultEnvelope<TSummary = Record<string, unknown>, TDetails = unknown> {
  ok: boolean;
  tool: string;
  workspaceId?: string;
  path?: string;
  summary?: TSummary;
  content: ToolContent[];
  details?: TDetails;
  diff?: string;
  diagnostics?: string[];
  truncated?: boolean;
  durationMs: number;
}

export function textContent(text: string): ToolContent[] {
  return [{ type: "text", text }];
}

export function toolError(message: string): ToolResponse {
  return { content: textContent(message), isError: true };
}

export function contentText(content: ToolContent[]): string {
  return content.map((item) => (item.type === "text" ? item.text : `[image:${item.mimeType}]`)).join("\n");
}

export function textSummary(text: string, maxLength = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

export function contentLineCount(content: ToolContent[]): number | undefined {
  const text = contentText(content);
  if (!text) return undefined;
  return text.split("\n").length;
}

export function makeToolResultEnvelope<TSummary = Record<string, unknown>, TDetails = unknown>(input: {
  ok: boolean;
  tool: string;
  workspaceId?: string;
  path?: string;
  summary?: TSummary;
  content: ToolContent[];
  details?: TDetails;
  diff?: string;
  diagnostics?: string[];
  truncated?: boolean;
  startedAt: number;
}): ToolResultEnvelope<TSummary, TDetails> {
  return {
    ok: input.ok,
    tool: input.tool,
    workspaceId: input.workspaceId,
    path: input.path,
    summary: input.summary,
    content: input.content,
    details: input.details,
    diff: input.diff,
    diagnostics: input.diagnostics,
    truncated: input.truncated,
    durationMs: Date.now() - input.startedAt,
  };
}
