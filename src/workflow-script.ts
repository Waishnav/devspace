export interface WorkflowScriptMeta {
  name: string;
  description?: string;
  concurrency: number;
}

export interface ParsedWorkflowScript {
  meta: WorkflowScriptMeta;
  body: string;
}

const DEFAULT_META: WorkflowScriptMeta = { name: "workflow", concurrency: 4 };
const META_PREFIX = /^(?:(?:\s+)|(?:\/\/[^\r\n]*(?:\r\n?|\n|$))|(?:\/\*[\s\S]*?\*\/))*export\s+const\s+meta\s*=/;

/** Parse the optional, data-only metadata declaration without executing workflow code. */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const prefix = META_PREFIX.exec(source);
  if (!prefix) return { meta: { ...DEFAULT_META }, body: source };

  const parser = new MetaParser(source, prefix[0].length);
  const fields = parser.object();
  parser.space();
  if (source[parser.position] === ";") parser.position += 1;

  const name = fields.name ?? DEFAULT_META.name;
  const description = fields.description;
  const concurrency = fields.concurrency ?? DEFAULT_META.concurrency;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 128) {
    throw new Error("Workflow meta.name must be a non-empty string of at most 128 characters.");
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 2_048)) {
    throw new Error("Workflow meta.description must be a string of at most 2048 characters.");
  }
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 16) {
    throw new Error("Workflow meta.concurrency must be an integer between 1 and 16.");
  }

  return {
    meta: {
      name: name.trim(),
      ...(description === undefined ? {} : { description }),
      concurrency: concurrency as number,
    },
    body: source.slice(parser.position),
  };
}

class MetaParser {
  position: number;

  constructor(private readonly source: string, position: number) {
    this.position = position;
  }

  object(): Record<string, string | number> {
    this.space();
    this.expect("{");
    const result: Record<string, string | number> = {};
    this.space();
    while (this.source[this.position] !== "}") {
      const key = this.key();
      if (key !== "name" && key !== "description" && key !== "concurrency") {
        throw this.error(`Unknown workflow metadata field: ${key}`);
      }
      if (Object.hasOwn(result, key)) throw this.error(`Duplicate workflow metadata field: ${key}`);
      this.space();
      this.expect(":");
      this.space();
      result[key] = this.source[this.position] === "'" || this.source[this.position] === '"'
        ? this.string()
        : this.number();
      this.space();
      if (this.source[this.position] !== ",") break;
      this.position += 1;
      this.space();
      if (this.source[this.position] === "}") break;
    }
    this.expect("}");
    return result;
  }

  space(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  private key(): string {
    this.space();
    if (this.source[this.position] === "'" || this.source[this.position] === '"') return this.string();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.position));
    if (!match) throw this.error("Expected a workflow metadata field.");
    this.position += match[0].length;
    return match[0];
  }

  private string(): string {
    const quote = this.source[this.position++];
    let value = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === quote) return value;
      if (character === "\n" || character === "\r") throw this.error("Workflow metadata strings cannot span lines.");
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = this.source[this.position++];
      const simple: Record<string, string> = {
        "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0",
      };
      if (escaped === "u") {
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw this.error("Invalid Unicode escape in workflow metadata.");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 4;
      } else if (escaped && Object.hasOwn(simple, escaped)) {
        value += simple[escaped];
      } else {
        throw this.error("Unsupported escape in workflow metadata.");
      }
    }
    throw this.error("Unterminated workflow metadata string.");
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(this.source.slice(this.position));
    if (!match) throw this.error("Workflow metadata values must be strings or numbers.");
    this.position += match[0].length;
    return Number(match[0]);
  }

  private expect(character: string): void {
    if (this.source[this.position] !== character) throw this.error(`Expected ${character} in workflow metadata.`);
    this.position += 1;
  }

  private error(message: string): SyntaxError {
    return new SyntaxError(`${message} (at character ${this.position})`);
  }
}
