export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse<TDetails = unknown> {
  [key: string]: unknown;
  content: ToolContent[];
  details?: TDetails;
  isError?: boolean;
}

export function textContent(text: string): ToolContent[] {
  return [{ type: "text", text }];
}

export function toolError<TDetails = unknown>(message: string): ToolResponse<TDetails> {
  return {
    content: textContent(message),
    isError: true,
  };
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function contentStats(content: ToolContent[]): { lines: number; characters: number } {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}
