export const DEFAULT_INLINE_OUTPUT_CHARACTERS = 12_000;

export interface OutputPreview {
  text: string;
  originalCharacters: number;
  originalLines: number;
  inlineCharacters: number;
  omittedCharacters: number;
  truncated: boolean;
}

const TRUNCATION_MARKER =
  "\n... DevSpace inline preview truncated; narrow the command or read a smaller range to retrieve more ...\n";

function codePoints(value: string): string[] {
  return Array.from(value);
}

function characterLength(value: string): number {
  return codePoints(value).length;
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.endsWith("\n")
    ? value.slice(0, -1).split("\n").length
    : value.split("\n").length;
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return codePoints(value).slice(0, count).join("");
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = codePoints(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

export function createOutputPreview(
  value: string,
  maxCharacters = DEFAULT_INLINE_OUTPUT_CHARACTERS,
): OutputPreview {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Inline output limit must be a positive integer.");
  }

  const originalCharacters = characterLength(value);
  const originalLines = lineCount(value);

  if (originalCharacters <= maxCharacters) {
    return {
      text: value,
      originalCharacters,
      originalLines,
      inlineCharacters: originalCharacters,
      omittedCharacters: 0,
      truncated: false,
    };
  }

  const markerCharacters = characterLength(TRUNCATION_MARKER);
  if (maxCharacters <= markerCharacters) {
    const text = takeHead(value, maxCharacters);
    return {
      text,
      originalCharacters,
      originalLines,
      inlineCharacters: characterLength(text),
      omittedCharacters: originalCharacters - characterLength(text),
      truncated: true,
    };
  }

  const available = maxCharacters - markerCharacters;
  const headCharacters = Math.ceil(available * 0.65);
  const tailCharacters = available - headCharacters;
  const text =
    takeHead(value, headCharacters) +
    TRUNCATION_MARKER +
    takeTail(value, tailCharacters);
  const inlineCharacters = characterLength(text);

  return {
    text,
    originalCharacters,
    originalLines,
    inlineCharacters,
    omittedCharacters: originalCharacters - headCharacters - tailCharacters,
    truncated: true,
  };
}

export function outputReceiptText(
  preview: OutputPreview,
  status?: string,
): string {
  const prefix = status ? `${status} ` : "";
  if (!preview.truncated) {
    return (
      `${prefix}Complete output is included in content ` +
      `(${preview.originalCharacters} characters, ${preview.originalLines} lines).`
    );
  }

  return (
    `${prefix}Content contains a bounded head/tail preview ` +
    `(${preview.inlineCharacters} of ${preview.originalCharacters} characters, ` +
    `${preview.originalLines} original lines; ${preview.omittedCharacters} characters omitted).`
  );
}

export function outputMetadata(preview: OutputPreview): {
  outputCharacters: number;
  outputLines: number;
  inlineOutputCharacters: number;
  inlineOutputTruncated: boolean;
  omittedOutputCharacters: number;
} {
  return {
    outputCharacters: preview.originalCharacters,
    outputLines: preview.originalLines,
    inlineOutputCharacters: preview.inlineCharacters,
    inlineOutputTruncated: preview.truncated,
    omittedOutputCharacters: preview.omittedCharacters,
  };
}
