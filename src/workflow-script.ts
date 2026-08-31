import { createHash } from "node:crypto";
import vm from "node:vm";
import { WORKFLOW_LIMITS, type WorkflowMeta } from "./workflow-types.js";
import { workflowMetaSchema } from "./workflow-contracts.js";

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
  /** Compiled async factory. Workflow APIs are installed as sandbox globals. */
  script: vm.Script;
  filename: string;
}

const META_EXPORT = /export\s+const\s+meta\s*=/;

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

  // Workflow APIs are installed as context-realm globals by the sandbox child.
  // Keeping the factory argument-free avoids handing host-realm functions or
  // constructors directly to model-authored workflow code.
  const wrapped = `(async () => {\n${body}\n})`;
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

  return { metaLiteral, metaEndIndex: end + 1 };
}

function scanBalancedObject(source: string, start: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
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
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
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

function evaluateMetaLiteral(literal: string, _filename: string): unknown {
  try {
    return new PureMetaLiteralParser(literal).parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptError("meta", `Invalid meta literal: ${message}`);
  }
}

class PureMetaLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipTrivia();
    const value = this.parseValue();
    this.skipTrivia();
    if (this.index !== this.source.length) {
      this.fail(`unexpected token ${JSON.stringify(this.source[this.index])}`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipTrivia();
    const ch = this.source[this.index];
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === "-" || (ch !== undefined && /\d/.test(ch))) return this.parseNumber();
    if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      const identifier = this.parseIdentifier();
      if (identifier === "true") return true;
      if (identifier === "false") return false;
      if (identifier === "null") return null;
      this.fail(`identifier ${identifier} is not a literal value`);
    }
    this.fail(`expected a literal value, got ${JSON.stringify(ch)}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    this.skipTrivia();
    if (this.consume("}")) return value;

    for (;;) {
      this.skipTrivia();
      const ch = this.source[this.index];
      const key = ch === '"' || ch === "'" ? this.parseString() : this.parseIdentifier();
      this.skipTrivia();
      this.expect(":");
      value[key] = this.parseValue();
      this.skipTrivia();
      if (this.consume("}")) return value;
      this.expect(",");
      this.skipTrivia();
      if (this.consume("}")) return value;
    }
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const value: unknown[] = [];
    this.skipTrivia();
    if (this.consume("]")) return value;

    for (;;) {
      value.push(this.parseValue());
      this.skipTrivia();
      if (this.consume("]")) return value;
      this.expect(",");
      this.skipTrivia();
      if (this.consume("]")) return value;
    }
  }

  private parseString(): string {
    const quote = this.source[this.index];
    if (quote !== '"' && quote !== "'") this.fail("expected a quoted string");
    this.index += 1;
    let value = "";

    while (this.index < this.source.length) {
      const ch = this.source[this.index++]!;
      if (ch === quote) return value;
      if (ch === "\n" || ch === "\r") this.fail("unterminated string literal");
      if (ch !== "\\") {
        value += ch;
        continue;
      }

      if (this.index >= this.source.length) this.fail("unterminated string escape");
      const escaped = this.source[this.index++]!;
      const simpleEscapes: Record<string, string> = {
        "\\": "\\",
        "\"": "\"",
        "'": "'",
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
      };
      if (escaped in simpleEscapes) {
        value += simpleEscapes[escaped];
        continue;
      }
      if (escaped === "x") {
        value += String.fromCodePoint(this.parseHexDigits(2));
        continue;
      }
      if (escaped === "u") {
        if (this.consume("{")) {
          const end = this.source.indexOf("}", this.index);
          if (end < 0) this.fail("unterminated Unicode escape");
          const digits = this.source.slice(this.index, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) this.fail("invalid Unicode escape");
          this.index = end + 1;
          const codePoint = Number.parseInt(digits, 16);
          if (codePoint > 0x10ffff) this.fail("Unicode escape is out of range");
          value += String.fromCodePoint(codePoint);
        } else {
          value += String.fromCodePoint(this.parseHexDigits(4));
        }
        continue;
      }
      if (escaped === "\n") continue;
      if (escaped === "\r") {
        this.consume("\n");
        continue;
      }
      value += escaped;
    }
    this.fail("unterminated string literal");
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.fail("invalid number literal");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number literal must be finite");
    return value;
  }

  private parseIdentifier(): string {
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match) this.fail("expected a static property name");
    this.index += match[0].length;
    return match[0];
  }

  private parseHexDigits(length: number): number {
    const digits = this.source.slice(this.index, this.index + length);
    if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) {
      this.fail("invalid hexadecimal escape");
    }
    this.index += length;
    return Number.parseInt(digits, 16);
  }

  private skipTrivia(): void {
    for (;;) {
      while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) {
        this.index += 1;
      }
      if (this.source.startsWith("//", this.index)) {
        const end = this.source.indexOf("\n", this.index + 2);
        this.index = end < 0 ? this.source.length : end + 1;
        continue;
      }
      if (this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end < 0) this.fail("unterminated block comment");
        this.index = end + 2;
        continue;
      }
      return;
    }
  }

  private expect(token: string): void {
    if (!this.consume(token)) this.fail(`expected ${JSON.stringify(token)}`);
  }

  private consume(token: string): boolean {
    if (!this.source.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  private fail(message: string): never {
    throw new Error(`${message} at offset ${this.index}`);
  }
}

function validateMeta(value: unknown): WorkflowMeta {
  const parsed = workflowMetaSchema.safeParse(value, { reportInput: true });
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `meta.${issue.path.join(".")}` : "meta";
  if (issue?.code === "invalid_type" && issue.input === undefined) {
    throw new WorkflowScriptError("meta", `${path} is required`);
  }
  if (issue?.code === "invalid_format" && issue.format === "regex") {
    throw new WorkflowScriptError("meta", `${path} must match /^[a-z0-9-]+$/`);
  }
  throw new WorkflowScriptError(
    "meta",
    `${path}: ${issue?.message ?? "validation failed"}`,
  );
}

function parseErrorLine(message: string): number | undefined {
  const match = message.match(/:(\d+)(?::\d+)?\)?$/m) ?? message.match(/line\s+(\d+)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}
