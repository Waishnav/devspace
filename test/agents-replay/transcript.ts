import { unsafeNarrow } from "../../src/unsafe-narrow.js";
import { isJsonString, isObjectValue } from "../../src/json-value.js";
import type { WireInput } from "../../src/json-value.js";
import { readFileSync } from "node:fs";
import { redactSecrets } from "../../src/local-agent-events.js";

/**
 * A transcript is the stdio traffic between one driver and one provider
 * process: a meta line, then one line per newline-delimited frame. `in` frames
 * were written by the driver to the provider's stdin, `out` frames were read
 * from its stdout. Frames are stored scrubbed: machine-specific paths become
 * placeholders and credential-shaped strings are redacted.
 */
export interface TranscriptMeta {
  type: "meta";
  provider: string;
  scenario: string;
  /** Provider arguments, scrubbed like frames. */
  args: string[];
  /** Where the driver started the provider process, scrubbed; replay requires the same. */
  cwd?: string;
  /** Output of `<command> --version`, replayed for drivers that probe it. */
  version?: string;
  recordedAt: string;
}

export interface TranscriptFrame {
  dir: "in" | "out";
  /** Milliseconds since the provider process started. */
  ms: number;
  frame: unknown;
}

export interface Transcript {
  meta: TranscriptMeta;
  frames: TranscriptFrame[];
}

export function readTranscript(path: string): Transcript {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  // SAFETY: The surrounding checks or construction already match this type.
  const [meta, ...frames] = lines.map((line) => JSON.parse(line) as unknown);

  // SAFETY: The surrounding checks or construction already match this type.
  if ((meta as TranscriptMeta | undefined)?.type !== "meta") {
    throw new Error(`${path} does not start with a transcript meta line.`);
  }

  // SAFETY: The surrounding checks or construction already match this type.
  return { meta: meta as TranscriptMeta, frames: frames as TranscriptFrame[] };
}

/** Machine-specific values replaced by placeholders, most specific first. */
export interface ScrubContext {
  workspace: string;
  /** The `--worktree` checkout the provider runs in, when the scenario uses one. */
  worktree?: string;
  home: string;
  tmp: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function placeholders(context: ScrubContext): Array<[string, string]> {
  return [
    ...(context.worktree
      // SAFETY: The surrounding checks or construction already match this type.
      ? unsafeNarrow<Array<[string, string]>>([[context.worktree, "$WORKTREE"], [context.worktree.replace(/[/\\.:]/g, "-"), "$WORKTREE_SLUG"]])
      : []),
    [context.workspace, "$WORKSPACE"],
    // Providers name per-project state directories after the cwd with separators dashed.
    [context.workspace.replace(/[/\\.:]/g, "-"), "$CWD_SLUG"],
    [context.tmp, "$TMP"],
    [context.home, "$HOME"],
  ];
}

export function scrub(value: WireInput, context: ScrubContext): WireInput {
  return mapStrings(value, (text) => {
    let next = text;

    for (const [actual, placeholder] of placeholders(context)) {
      if (actual) next = next.replaceAll(actual, placeholder);
    }

    return redactSecrets(next).replace(EMAIL, "user@example.invalid");
  });
}

export function restore(value: WireInput, context: ScrubContext): WireInput {
  return mapStrings(value, (text) => {
    let next = text;

    for (const [actual, placeholder] of placeholders(context)) next = next.replaceAll(placeholder, actual);

    return next;
  });
}

export function mapStrings(value: WireInput, map: (text: string) => string): WireInput {
  if (isJsonString(value)) return map(value);

  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));

  if (value && isObjectValue(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]));
  }

  return value;
}

/** Parses one stdio line; lines that are not JSON are kept as raw strings. */
export function parseFrame(line: string): WireInput {
  try {
    // SAFETY: The surrounding checks or construction already match this type.
    return JSON.parse(line) as WireInput;
  } catch {
    return { raw: line };
  }
}
