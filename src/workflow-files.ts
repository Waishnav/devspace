import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { hashSource } from "./workflow-script.js";
import { jsonValueSchema, type JsonValue } from "./json-types.js";
import {
  InvalidWorkflowInputError,
  NamedWorkflowNotFoundError,
  WorkflowFileNotFoundError,
  WorkflowFileReadError,
  WorkflowFileWriteError,
} from "./workflow-errors.js";
import { isPathInsideRoot } from "./roots.js";

export interface ResolvedWorkflowScript {
  source: string;
  scriptPath: string;
  scriptHash: string;
  nameHint: string;
  origin: "file" | "named" | "inline" | "resume";
}

export type WorkflowFileResolveError =
  | InvalidWorkflowInputError
  | NamedWorkflowNotFoundError
  | WorkflowFileNotFoundError
  | WorkflowFileReadError;

/**
 * Persist script under stateDir for worker re-read / audit.
 * Returns absolute path written.
 */
export async function persistWorkflowScriptResult(input: {
  stateDir: string;
  runId: string;
  source: string;
  preferredName?: string;
}): Promise<BetterResult<string, WorkflowFileWriteError>> {
  const dir = join(input.stateDir, "workflow-scripts", input.runId);
  const base =
    sanitizeSegment(input.preferredName ?? "script") ||
    `script-${randomBytes(3).toString("hex")}`;
  const path = join(dir, `${base}.js`);
  return Result.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path, input.source, { encoding: "utf8", mode: 0o600 });
      return path;
    },
    catch: (cause) => new WorkflowFileWriteError(path, cause),
  });
}

export async function readWorkflowScriptFileResult(
  path: string,
): Promise<BetterResult<ResolvedWorkflowScript, WorkflowFileNotFoundError | WorkflowFileReadError>> {
  const scriptPath = resolve(path);
  return Result.tryPromise({
    try: async () => {
      const source = await readFile(scriptPath, "utf8");
      return {
        source,
        scriptPath,
        scriptHash: hashSource(source),
        nameHint: basename(scriptPath, extname(scriptPath)),
        origin: "file" as const,
      };
    },
    catch: (cause) =>
      isFileNotFound(cause)
        ? new WorkflowFileNotFoundError(scriptPath)
        : new WorkflowFileReadError(scriptPath, cause),
  });
}

/** Resolve an explicit nested script only inside `<project>/.devspace/workflows`. */
export async function readProjectWorkflowScriptFileResult(input: {
  scriptPath: string;
  workspaceRoot: string;
}): Promise<BetterResult<ResolvedWorkflowScript, WorkflowFileResolveError>> {
  const projectWorkflowRoot = resolve(input.workspaceRoot, ".devspace", "workflows");
  const requestedPath = isAbsolute(input.scriptPath)
    ? resolve(input.scriptPath)
    : resolve(projectWorkflowRoot, input.scriptPath);

  if (!isPathInsideRoot(requestedPath, projectWorkflowRoot)) {
    return Result.err(
      new InvalidWorkflowInputError({
        code: "invalid_path",
        message: `Nested workflow script must be inside ${projectWorkflowRoot}`,
      }),
    );
  }

  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(projectWorkflowRoot),
      realpath(requestedPath),
    ]);
  } catch (cause) {
    return Result.err(
      isFileNotFound(cause)
        ? new WorkflowFileNotFoundError(requestedPath)
        : new WorkflowFileReadError(requestedPath, cause),
    );
  }

  if (!isPathInsideRoot(canonicalPath, canonicalRoot)) {
    return Result.err(
      new InvalidWorkflowInputError({
        code: "invalid_path",
        message: `Nested workflow script resolves outside ${projectWorkflowRoot}`,
      }),
    );
  }
  return readWorkflowScriptFileResult(canonicalPath);
}

/**
 * Resolve named workflow script.
 * Search order:
 * 1. `<cwd>/.devspace/workflows/<name>.js`
 * 2. `<stateDir>/workflows/<name>.js` (if stateDir provided)
 */
export async function resolveNamedWorkflowScriptResult(input: {
  name: string;
  workspaceRoot: string;
  stateDir?: string;
}): Promise<BetterResult<ResolvedWorkflowScript, WorkflowFileResolveError>> {
  const name = input.name.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return Result.err(
      new InvalidWorkflowInputError({
        code: "invalid_name",
        message: `Invalid workflow name: ${JSON.stringify(input.name)}`,
      }),
    );
  }
  const candidates = [
    join(input.workspaceRoot, ".devspace", "workflows", `${name}.js`),
  ];
  if (input.stateDir) {
    candidates.push(join(input.stateDir, "workflows", `${name}.js`));
  }
  for (const candidate of candidates) {
    const result = await readWorkflowScriptFileResult(candidate);
    if (result.isOk()) {
      return Result.ok({ ...result.value, nameHint: name, origin: "named" as const });
    }
    if (WorkflowFileNotFoundError.is(result.error)) continue;
    return result;
  }
  return Result.err(new NamedWorkflowNotFoundError(name, candidates));
}

export async function resolveWorkflowScriptFromPathOrNameResult(input: {
  file?: string;
  name?: string;
  workspaceRoot: string;
  stateDir?: string;
}): Promise<BetterResult<ResolvedWorkflowScript, WorkflowFileResolveError>> {
  if (input.file && input.name) {
    return Result.err(
      new InvalidWorkflowInputError({
        code: "ambiguous_source",
        message: "Pass only one of --file or --name",
      }),
    );
  }
  if (input.file) {
    const path = isAbsolute(input.file)
      ? input.file
      : resolve(input.workspaceRoot, input.file);
    return readWorkflowScriptFileResult(path);
  }
  if (input.name) {
    return resolveNamedWorkflowScriptResult({
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      stateDir: input.stateDir,
    });
  }
  return Result.err(
    new InvalidWorkflowInputError({
      code: "missing_source",
      message: "Provide --file <path> or --name <name>",
    }),
  );
}

export function parseWorkflowArgFlagsResult(
  tokens: string[],
): BetterResult<
  { args: Record<string, JsonValue>; rest: string[] },
  InvalidWorkflowInputError
> {
  const args: Record<string, JsonValue> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--arg") {
      const pair = tokens[++i];
      if (!pair || !pair.includes("=")) {
        return Result.err(
          new InvalidWorkflowInputError({
            code: "invalid_argument",
            message: "--arg requires key=value",
          }),
        );
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
      if (eq < 0) {
        return Result.err(
          new InvalidWorkflowInputError({
            code: "invalid_argument",
            message: "--arg requires key=value",
          }),
        );
      }
      args[pair.slice(0, eq)] = coerceArgValue(pair.slice(eq + 1));
      continue;
    }
    rest.push(token);
  }
  return Result.ok({ args, rest });
}

function coerceArgValue(raw: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
}

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
