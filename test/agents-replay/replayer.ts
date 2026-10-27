import type { ReplayProtocol } from "./providers.js";
import { restore, scrub, type ScrubContext, type Transcript, type TranscriptFrame } from "./transcript.js";
import { isJsonObject } from "../../src/json-value.js";
import type { JsonObject, JsonValue } from "../../src/json-value.js";

export interface ReplayerOptions {
  transcript: Transcript;
  protocol: ReplayProtocol;
  context: ScrubContext;
  emit(frame: JsonValue): void;
  fail(report: string): void;
  /** Upper bound for a recorded gap between provider frames. */
  maxGapMs?: number;
}

/**
 * Plays the provider side of a transcript. Each driver frame must match the
 * next recorded `in` frame by kind and shape; the provider frames recorded
 * after it are then emitted in order, with recorded gaps capped so replay is
 * fast but keeps its ordering. A turn that was stopped in the recording waits
 * for the driver's stop request, because the frames after it belong to that
 * request.
 */
export class Replayer {
  private cursor = 0;
  private readonly pending: TranscriptFrame[] = [];
  private timer?: NodeJS.Timeout;
  private lastMs = 0;
  private failed = false;
  /** Recorded volatile value (JSON) -> live value. */
  private readonly bindings = new Map<string, unknown>();
  /** Request ids of recorded elastic requests the driver never sent. */
  private readonly skipped = new Set<string>();

  constructor(private readonly options: ReplayerOptions) {}

  start(): void {
    this.queueProviderFrames();
  }

  receive(live: JsonValue): void {
    if (this.failed) return;
    const { protocol } = this.options;
    const actual = scrub(live, this.options.context);
    const kind = frameKind(protocol, actual);

    if (protocol.elasticKinds.has(kind)) {
      this.answerElastic(kind, actual);

      return;
    }

    const next = this.options.transcript.frames[this.cursor];
    const nextKind = next ? frameKind(protocol, next.frame) : undefined;

    if (!next || nextKind !== kind) {
      this.reportFailure(
        next
          ? `Driver sent ${kind} but the recording expects ${nextKind} next (frame #${this.cursor}):`
          : `Driver sent ${kind} after the recording ended:`,
        next ? diff(next.frame, actual, protocol.volatileKeys) : [],
        next?.frame,
        actual,
      );

      return;
    }

    this.flush();
    const differences = diff(next.frame, actual, protocol.volatileKeys);

    if (differences.length > 0) {
      this.reportFailure(`Driver frame #${this.cursor} (${kind}) does not match the recording:`, differences, next.frame, actual);

      return;
    }

    this.bind(next.frame, actual);
    this.lastMs = next.ms;
    this.cursor += 1;
    this.queueProviderFrames();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Queues provider frames up to the next driver frame that must be matched.
   * Recorded elastic requests never gate playback; live ones are answered on demand.
   */
  private queueProviderFrames(): void {
    const { frames } = this.options.transcript;
    const { protocol } = this.options;

    for (;;) {
      const next = frames[this.cursor];

      if (next?.dir === "out") {
        this.pending.push(next);
      } else if (next && protocol.elasticKinds.has(frameKind(protocol, next.frame))) {
        this.skipped.add(JSON.stringify(protocol.requestId(asRecord(next.frame))));
      } else {
        break;
      }

      this.cursor += 1;
    }

    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.pending.length === 0) return;
    const next = this.pending[0]!;
    const gap = Math.max(0, Math.min(this.options.maxGapMs ?? 25, next.ms - this.lastMs));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitPending(this.pending.shift()!);
      this.schedule();
    }, gap);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    for (const frame of this.pending.splice(0)) this.emitPending(frame);
  }

  private emitPending(entry: TranscriptFrame): void {
    this.lastMs = entry.ms;
    const answers = this.options.protocol.responseTo(asRecord(entry.frame));

    if (answers !== undefined && this.skipped.has(JSON.stringify(answers))) return;
    this.emit(entry.frame);
  }

  private emit(frame: JsonValue, extra?: Map<string, unknown>): void {
    const { volatileKeys } = this.options.protocol;

    const bound = rewriteVolatile(frame, volatileKeys, (value) => {
      const key = JSON.stringify(value);

      if (extra?.has(key)) return extra.get(key);

      return this.bindings.has(key) ? this.bindings.get(key) : value;
    });

    this.options.emit(restore(bound, this.options.context));
  }

  /** Answers a timing-dependent request with the closest recorded response of the same kind. */
  private answerElastic(kind: string, actual: JsonValue): void {
    const { frames } = this.options.transcript;
    const { protocol } = this.options;

    const candidates = frames
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.dir === "in" && frameKind(protocol, entry.frame) === kind)
      .sort((left, right) => Math.abs(left.index - this.cursor) - Math.abs(right.index - this.cursor));

    for (const { entry } of candidates) {
      const recordedId = protocol.requestId(asRecord(entry.frame));

      const response = frames.find((candidate) => (
        candidate.dir === "out"
        && JSON.stringify(protocol.responseTo(asRecord(candidate.frame))) === JSON.stringify(recordedId)
      ));

      if (!response) continue;
      const liveId = protocol.requestId(asRecord(actual));
      this.emit(response.frame, new Map([[JSON.stringify(recordedId), liveId]]));

      return;
    }

    this.reportFailure(`Driver sent ${kind} but the recording has no response to replay for it:`, [], undefined, actual);
  }

  private bind(recorded: JsonValue, actual: JsonValue): void {
    const { volatileKeys } = this.options.protocol;
    walkPairs(recorded, actual, (key, left, right) => {
      if (volatileKeys.has(key) && left !== right && isPrimitive(left)) {
        this.bindings.set(JSON.stringify(left), right);
      }
    });
  }

  private reportFailure(headline: string, differences: string[], expected: JsonValue, actual: JsonValue): void {
    this.failed = true;
    this.flush();

    const lines = [
      headline,
      ...differences.map((line) => `  ${line}`),
      ...(expected === undefined ? [] : [`  expected: ${JSON.stringify(expected)}`]),
      `  actual:   ${JSON.stringify(actual)}`,
    ];

    this.options.fail(lines.join("\n"));
  }
}

function frameKind(protocol: ReplayProtocol, frame: JsonValue): string {
  return protocol.kind(asRecord(frame));
}

/** Readable structural differences; volatile keys only need matching types. */
export function diff(expected: JsonValue, actual: JsonValue, volatileKeys: ReadonlySet<string>, path = "$"): string[] {
  const key = path.slice(path.lastIndexOf(".") + 1);

  if (volatileKeys.has(key)) {
    return typeOf(expected) === typeOf(actual)
      ? []
      : [`${path}: expected a ${typeOf(expected)}, got ${JSON.stringify(actual)}`];
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const lines = expected.length === actual.length
      ? []
      : [`${path}: expected ${expected.length} items, got ${actual.length}`];

    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      lines.push(...diff(expected[index], actual[index], volatileKeys, `${path}[${index}]`));
    }

    return lines;
  }

  if (isObject(expected) && isObject(actual)) {
    const lines: string[] = [];

    for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(name in actual)) lines.push(`${path}.${name}: missing`);
      else if (!(name in expected)) lines.push(`${path}.${name}: unexpected ${JSON.stringify(actual[name])}`);
      else lines.push(...diff(expected[name], actual[name], volatileKeys, `${path}.${name}`));
    }

    return lines;
  }

  return expected === actual
    ? []
    : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function walkPairs(left: JsonValue, right: JsonValue, visit: (key: string, left: JsonValue, right: JsonValue) => void): void {
  if (Array.isArray(left) && Array.isArray(right)) {
    left.forEach((entry, index) => walkPairs(entry, right[index], visit));
  } else if (isObject(left) && isObject(right)) {
    for (const [key, value] of Object.entries(left)) {
      visit(key, value, right[key]);
      walkPairs(value, right[key], visit);
    }
  }
}

function rewriteVolatile(value: JsonValue, keys: ReadonlySet<string>, rewrite: (value: JsonValue) => unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteVolatile(entry, keys, rewrite));

  if (!isObject(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    keys.has(key) && isPrimitive(entry) ? rewrite(entry) : rewriteVolatile(entry, keys, rewrite),
  ]));
}

function typeOf(value: JsonValue): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function isPrimitive(value: JsonValue): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && isJsonObject(value) && !Array.isArray(value);
}

function asRecord(value: JsonValue): JsonObject {
  return isObject(value) ? value : {};
}
