/**
 * Output truncation — PR #85.
 *
 * Provides Unicode-safe truncation for MCP inline tool output.
 * Preserves the start and end of output, inserts an ellipsis marker in the middle,
 * and reports original/inline character counts, line counts, and truncation status.
 *
 * The limit is configurable via DEVSPACE_INLINE_OUTPUT_CHARACTERS (default 12000)
 * or config.json inlineOutputCharacters.
 *
 * Key rules:
 *  - Uses Array.from(str) to avoid splitting surrogate pairs (emoji, CJK extensions).
 *  - Never produces broken characters.
 *  - Returns originalChars, originalLines, inlineChars, truncated, omittedChars.
 *  - Executor-level truncation is separate from MCP inline truncation.
 */

export interface TruncationResult {
  /** The (possibly truncated) text. */
  text: string;
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Original character count (by code points). */
  originalChars: number;
  /** Original line count. */
  originalLines: number;
  /** Final inline character count (by code points). */
  inlineChars: number;
  /** Number of characters omitted. */
  omittedChars: number;
}

export const DEFAULT_INLINE_OUTPUT_CHARACTERS = 12000;

/**
 * Parse the inline output character limit from an env value or config value.
 * Falls back to DEFAULT_INLINE_OUTPUT_CHARACTERS (12000) on invalid input.
 */
export function parseInlineOutputCharacters(
  envValue: string | undefined,
  configValue: number | undefined,
): number {
  const raw = envValue ?? configValue ?? DEFAULT_INLINE_OUTPUT_CHARACTERS;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_INLINE_OUTPUT_CHARACTERS;
  if (n > 200000) return 200000;
  return n;
}

/**
 * Unicode-safe truncation of a string.
 *
 * Keeps the first `headChars` and last `tailChars` code points, inserting
 * a marker in between that reports how many characters were omitted.
 */
export function truncateInlineOutput(
  text: string,
  maxCharacters: number = DEFAULT_INLINE_OUTPUT_CHARACTERS,
): TruncationResult {
  const codePoints = Array.from(text);
  const originalChars = codePoints.length;
  const originalLines = text.split(/\r\n|\r|\n/).length;

  if (originalChars <= maxCharacters) {
    return {
      text,
      truncated: false,
      originalChars,
      originalLines,
      inlineChars: originalChars,
      omittedChars: 0,
    };
  }

  if (maxCharacters <= 0) {
    return {
      text: "",
      truncated: true,
      originalChars,
      originalLines,
      inlineChars: 0,
      omittedChars: originalChars,
    };
  }

  // Reserve space for the marker
  const marker = `\n... [output truncated: omitted {OMITTED} of ${originalChars} characters] ...\n`;
  // We'll compute omitted after sizing head/tail
  const markerOverhead = Array.from(marker.replace("{OMITTED}", "0")).length + 6; // approx for digit width
  const available = Math.max(100, maxCharacters - markerOverhead);
  const head = Math.ceil(available * 0.6);
  const tail = Math.floor(available * 0.4);

  const headText = codePoints.slice(0, head).join("");
  const tailText = codePoints.slice(originalChars - tail).join("");
  const omitted = originalChars - head - tail;
  const finalMarker = marker.replace("{OMITTED}", String(omitted));
  const resultText = headText + finalMarker + tailText;
  const inlineChars = Array.from(resultText).length;

  return {
    text: resultText,
    truncated: true,
    originalChars,
    originalLines,
    inlineChars,
    omittedChars: omitted,
  };
}

/**
 * Wrap a tool result text for MCP inline content.
 *
 * Applies truncation and returns both the text content and structured metadata.
 * When widgets are off, no card payload is attached.
 */
export function wrapInlineOutput(
  text: string,
  maxCharacters: number,
  opts: { widgetsOff?: boolean; isError?: boolean } = {},
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  truncation: TruncationResult;
} {
  const truncation = truncateInlineOutput(text, maxCharacters);
  const content = [{ type: "text" as const, text: truncation.text }];

  // structuredContent carries truncation metadata without duplicating full output
  const structuredContent: Record<string, unknown> = {
    truncated: truncation.truncated,
    originalChars: truncation.originalChars,
    originalLines: truncation.originalLines,
    inlineChars: truncation.inlineChars,
    omittedChars: truncation.omittedChars,
    isError: opts.isError ?? false,
  };

  // No card payload when widgets are off (PR #85 requirement)
  return { content, structuredContent, truncation };
}
