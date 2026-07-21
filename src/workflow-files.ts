import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { hashSource } from "./workflow-script.js";
import { jsonValueSchema, type JsonValue } from "./json-types.js";

export class WorkflowPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPathError";
  }
}

export interface ResolvedWorkflowScript {
  source: string;
  scriptPath: string;
  scriptHash: string;
  nameHint: string;
  origin: "file" | "named" | "inline" | "resume";
}

/**
 * Persist script under stateDir for worker re-read / audit.
 * Returns absolute path written.
 */
export async function persistWorkflowScript(input: {
  stateDir: string;
  runId: string;
  source: string;
  preferredName?: string;
}): Promise<string> {
  const dir = join(input.stateDir, "workflow-scripts", input.runId);
  await mkdir(dir, { recursive: true });
  const base =
    sanitizeSegment(input.preferredName ?? "script") ||
    `script-${randomBytes(3).toString("hex")}`;
  const path = join(dir, `${base}.js`);
  await writeFile(path, input.source, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function readWorkflowScriptFile(path: string): Promise<ResolvedWorkflowScript> {
  const scriptPath = resolve(path);
  await assertReadableFile(scriptPath);
  const source = await readFile(scriptPath, "utf8");
  return {
    source,
    scriptPath,
    scriptHash: hashSource(source),
    nameHint: basename(scriptPath, extname(scriptPath)),
    origin: "file",
  };
}

/**
 * Resolve named workflow script.
 * Search order:
 * 1. `<cwd>/.devspace/workflows/<name>.js`
 * 2. `<cwd>/workflows/<name>.js`
 * 3. `<stateDir>/workflows/<name>.js` (if stateDir provided)
 */
export async function resolveNamedWorkflowScript(input: {
  name: string;
  workspaceRoot: string;
  stateDir?: string;
}): Promise<ResolvedWorkflowScript> {
  const name = input.name.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new WorkflowPathError(`Invalid workflow name: ${JSON.stringify(input.name)}`);
  }
  const candidates = [
    join(input.workspaceRoot, ".devspace", "workflows", `${name}.js`),
    join(input.workspaceRoot, "workflows", `${name}.js`),
  ];
  if (input.stateDir) {
    candidates.push(join(input.stateDir, "workflows", `${name}.js`));
  }
  for (const candidate of candidates) {
    try {
      await assertReadableFile(candidate);
      const source = await readFile(candidate, "utf8");
      return {
        source,
        scriptPath: candidate,
        scriptHash: hashSource(source),
        nameHint: name,
        origin: "named",
      };
    } catch {
      // try next
    }
  }
  throw new WorkflowPathError(
    `Named workflow not found: ${name}. Looked in ${candidates.join(", ")}`,
  );
}

export async function resolveWorkflowScriptFromPathOrName(input: {
  file?: string;
  name?: string;
  workspaceRoot: string;
  stateDir?: string;
}): Promise<ResolvedWorkflowScript> {
  if (input.file && input.name) {
    throw new WorkflowPathError("Pass only one of --file or --name");
  }
  if (input.file) {
    const path = isAbsolute(input.file)
      ? input.file
      : resolve(input.workspaceRoot, input.file);
    return readWorkflowScriptFile(path);
  }
  if (input.name) {
    return resolveNamedWorkflowScript({
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      stateDir: input.stateDir,
    });
  }
  throw new WorkflowPathError("Provide --file <path> or --name <name>");
}

export function parseWorkflowArgFlags(tokens: string[]): {
  args: Record<string, JsonValue>;
  rest: string[];
} {
  const args: Record<string, JsonValue> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--arg") {
      const pair = tokens[++i];
      if (!pair || !pair.includes("=")) {
        throw new WorkflowPathError("--arg requires key=value");
      }
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      args[key] = coerceArgValue(raw);
      continue;
    }
    if (token.startsWith("--arg=")) {
      const pair = token.slice("--arg=".length);
      const eq = pair.indexOf("=");
      if (eq < 0) throw new WorkflowPathError("--arg requires key=value");
      args[pair.slice(0, eq)] = coerceArgValue(pair.slice(eq + 1));
      continue;
    }
    rest.push(token);
  }
  return { args, rest };
}

function coerceArgValue(raw: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
}

async function assertReadableFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new WorkflowPathError(`Script file not found: ${path}`);
  }
}

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function workflowScriptDirForRun(stateDir: string, runId: string): string {
  return join(stateDir, "workflow-scripts", runId);
}

export function contentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function dirnameOf(path: string): string {
  return dirname(path);
}
