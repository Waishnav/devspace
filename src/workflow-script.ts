import { createHash } from "node:crypto";
import vm from "node:vm";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import { WORKFLOW_LIMITS, type WorkflowMeta } from "./workflow-types.js";

export class WorkflowScriptError extends Error {
  constructor(
    readonly kind: "syntax" | "meta" | "script_too_large",
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "WorkflowScriptError";
  }
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  source: string;
  scriptHash: string;
  /** Compiled async factory: (api) => Promise<unknown> */
  script: vm.Script;
  filename: string;
}

const META_EXPORT = /export\s+const\s+meta\s*=/;
const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Parse + compile a workflow script.
 * Expects `export const meta = {…}` as the first statement (optional leading comments/blank).
 */
export function parseWorkflowScript(
  source: string,
  options: { filename?: string } = {},
): ParsedWorkflowScript {
  if (Buffer.byteLength(source, "utf8") > WORKFLOW_LIMITS.scriptSourceBytes) {
    throw new WorkflowScriptError(
      "script_too_large",
      `Script exceeds ${WORKFLOW_LIMITS.scriptSourceBytes} bytes`,
    );
  }

  const filename = options.filename ?? "workflow:inline";
  const normalized = source.replace(/^﻿/, "");
  const { metaLiteral } = extractMetaLiteral(normalized);
  const meta = validateMeta(evaluateMetaLiteral(metaLiteral, filename));

  // Strip only the leading `export ` so line numbers stay aligned (7 spaces).
  const body = normalized.replace(META_EXPORT, "       const meta =");

  // Reject further imports / exports after transform
  if (/\bimport\s+/.test(body) || /\bexport\s+/.test(body)) {
    throw new WorkflowScriptError(
      "syntax",
      "Workflow scripts may not use import or additional export statements",
    );
  }

  // Inject host APIs as params. `meta` stays as the script's own `const meta`
  // (would TDZ/redeclare if also injected). `console` lives on the sandbox globals.
  const wrapped = `(async ({ agent, parallel, pipeline, phase, log, args, budget, workflow }) => {\n${body}\n})`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, {
      filename,
      // Outer async wrapper adds one line before user source
      lineOffset: -1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = parseErrorLine(message);
    throw new WorkflowScriptError("syntax", message, line);
  }

  return {
    meta,
    source: normalized,
    scriptHash: hashSource(normalized),
    script,
    filename,
  };
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function extractMetaLiteral(source: string): { metaLiteral: string; metaEndIndex: number } {
  const match = META_EXPORT.exec(source);
  if (!match || match.index === undefined) {
    throw new WorkflowScriptError(
      "meta",
      "Workflow script must start with `export const meta = { … }`",
    );
  }

  // Ensure only whitespace/comments before export
  const before = source.slice(0, match.index);
  if (!isOnlyPreamble(before)) {
    throw new WorkflowScriptError(
      "meta",
      "`export const meta` must be the first statement (comments/blank lines OK)",
    );
  }

  const afterAssign = source.slice(match.index + match[0].length);
  const trimmedStart = afterAssign.match(/^\s*/)?.[0].length ?? 0;
  const objectStart = match.index + match[0].length + trimmedStart;
  if (source[objectStart] !== "{") {
    throw new WorkflowScriptError("meta", "meta value must be an object literal `{…}`");
  }

  const end = scanBalancedObject(source, objectStart);
  const metaLiteral = source.slice(objectStart, end + 1);

  // Purity: no calls, spreads, templates inside meta (rough static checks)
  if (/[`$]/.test(metaLiteral) && /\$\{/.test(metaLiteral)) {
    throw new WorkflowScriptError("meta", "meta must be a pure literal (no template interpolation)");
  }
  if (/\.\.\./.test(metaLiteral)) {
    throw new WorkflowScriptError("meta", "meta must be a pure literal (no spreads)");
  }
  // Disallow identifier references that look like calls: word(
  if (/\b[A-Za-z_$][\w$]*\s*\(/.test(metaLiteral)) {
    throw new WorkflowScriptError("meta", "meta must be a pure literal (no function calls)");
  }

  return { metaLiteral, metaEndIndex: end + 1 };
}

function scanBalancedObject(source: string, start: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new WorkflowScriptError("meta", "Unclosed meta object literal");
}

function isOnlyPreamble(text: string): boolean {
  // strip block comments, line comments, whitespace
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();
  return stripped.length === 0;
}

function evaluateMetaLiteral(literal: string, filename: string): unknown {
  try {
    const value = vm.runInNewContext(`(${literal})`, Object.create(null), {
      filename: `${filename}:meta`,
      timeout: 1000,
    });
    // Rehydrate into the host realm — vm values keep context prototypes which
    // break assert.deepEqual and other host identity checks.
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptError("meta", `Invalid meta literal: ${message}`);
  }
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowScriptError("meta", "meta must be an object");
  }
  const record = value as Record<string, unknown>;
  const name = readRequiredString(record, "name");
  if (!NAME_RE.test(name)) {
    throw new WorkflowScriptError(
      "meta",
      `meta.name must match ${NAME_RE} (got ${JSON.stringify(name)})`,
    );
  }
  const description = readRequiredString(record, "description");

  let phases: WorkflowMeta["phases"];
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      throw new WorkflowScriptError("meta", "meta.phases must be an array");
    }
    const hostPhases: NonNullable<WorkflowMeta["phases"]> = [];
    for (let index = 0; index < record.phases.length; index += 1) {
      const phase = record.phases[index];
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
        throw new WorkflowScriptError("meta", `meta.phases[${index}] must be an object`);
      }
      const p = phase as Record<string, unknown>;
      const title = readRequiredString(p, "title", `meta.phases[${index}].title`);
      const detail = optionalString(p.detail);
      hostPhases.push(detail === undefined ? { title } : { title, detail });
    }
    phases = hostPhases;
  }

  const whenToUse = optionalString(record.whenToUse);
  let defaultProvider: LocalAgentProvider | undefined;
  if (record.defaultProvider !== undefined) {
    if (typeof record.defaultProvider !== "string" || !isLocalAgentProvider(record.defaultProvider)) {
      throw new WorkflowScriptError(
        "meta",
        `meta.defaultProvider must be one of: ${LOCAL_AGENT_PROVIDERS.join(", ")}`,
      );
    }
    defaultProvider = record.defaultProvider;
  }

  let concurrency: number | undefined;
  if (record.concurrency !== undefined) {
    if (typeof record.concurrency !== "number" || !Number.isFinite(record.concurrency)) {
      throw new WorkflowScriptError("meta", "meta.concurrency must be a number");
    }
    concurrency = Math.floor(record.concurrency);
    if (concurrency < 1) {
      throw new WorkflowScriptError("meta", "meta.concurrency must be >= 1");
    }
  }

  return {
    name,
    description,
    ...(phases ? { phases } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  label = `meta.${key}`,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowScriptError("meta", `${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseErrorLine(message: string): number | undefined {
  const match = message.match(/:(\d+)(?::\d+)?\)?$/m) ?? message.match(/line\s+(\d+)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}
