import { createRequire } from "node:module";
import { Result, type Result as BetterResult } from "better-result";
import { WORKFLOW_MAX_SCHEMA_RETRIES } from "./workflow-types.js";
import { tryExtractJson, WorkflowEngineError } from "./workflow-api.js";
import type { WorkflowProviderRunResult, WorkflowRunProvider } from "./workflow-api.js";
import {
  classifyAgentProviderError,
  isProviderSchemaUnsupportedError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import { supportsNativeStructuredOutput } from "./local-agent-capabilities.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  jsonValueSchema,
  type JsonSchema,
  type JsonValue,
} from "./json-types.js";
import {
  AgentSchemaValidationError,
  InvalidAgentJsonError,
  SchemaConfigurationError,
  SchemaRetriesExhaustedError,
  type SchemaAttemptError,
} from "./workflow-errors.js";

const require = createRequire(import.meta.url);

type AjvLike = new (opts?: object) => {
  compile: (schema: JsonSchema) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  };
};

function loadAjv(): AjvLike {
  // Prefer direct package; fall back to transitive install under zod or package-lock.
  try {
    return require("ajv").default ?? require("ajv");
  } catch {
    throw new WorkflowEngineError(
      "schema",
      "ajv is required for opts.schema (add dependency ajv)",
    );
  }
}

export type SchemaEnforceMode = "native" | "prompt";

export interface EnforceSchemaInput {
  schema: JsonSchema;
  prompt: string;
  /**
   * Provider id for native-vs-prompt policy. When in NATIVE_SCHEMA_PROVIDERS,
   * attempt 0 uses raw prompt + native structured path; later attempts repair via prompt.
   */
  provider: LocalAgentProvider;
  run: (
    prompt: string,
    opts: {
      mode: SchemaEnforceMode;
      providerSessionId?: string;
    },
  ) => Promise<WorkflowProviderRunResult>;
  onRetry?: (info: {
    attempt: number;
    errors: string;
    mode: SchemaEnforceMode;
  }) => void;
  maxRetries?: number;
}

export interface EnforceSchemaResult {
  value: JsonValue;
  finalResponse: string;
  providerSessionId?: string;
  attempts: number;
  mode: SchemaEnforceMode;
}

export type EnforceSchemaError =
  | AgentProviderError
  | SchemaConfigurationError
  | SchemaRetriesExhaustedError;

/**
 * Native-first for codex/claude; otherwise prompt+extract+Ajv. Always Ajv-validate.
 * Retries ≤ WORKFLOW_MAX_SCHEMA_RETRIES after the first attempt.
 */
export async function enforceAgentSchema(
  input: EnforceSchemaInput,
): Promise<EnforceSchemaResult> {
  const result = await enforceAgentSchemaResult(input);
  if (result.isOk()) return result.value;
  if (
    SchemaConfigurationError.is(result.error) ||
    SchemaRetriesExhaustedError.is(result.error)
  ) {
    throw new WorkflowEngineError("schema", result.error.message);
  }
  throw result.error;
}

export async function enforceAgentSchemaResult(
  input: EnforceSchemaInput,
): Promise<BetterResult<EnforceSchemaResult, EnforceSchemaError>> {
  const compiled = Result.try({
    try: () => {
      const Ajv = loadAjv();
      const ajv = new Ajv({ allErrors: true, strict: false });
      return ajv.compile(input.schema);
    },
    catch: (cause) => new SchemaConfigurationError(cause),
  });
  if (compiled.isErr()) return compiled;
  const validate = compiled.value;
  const maxRetries = input.maxRetries ?? WORKFLOW_MAX_SCHEMA_RETRIES;
  const native = supportsNativeStructuredOutput(input.provider);
  const basePrompt = augmentPromptForSchema(input.prompt, input.schema);

  let lastFailure: SchemaAttemptError | undefined;
  let providerSessionId: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const mode: SchemaEnforceMode = native && attempt === 0 ? "native" : "prompt";

    const prompt =
      mode === "native"
        ? input.prompt
        : attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nPrevious JSON failed validation:\n${lastFailure?.message ?? "unknown validation error"}\nReturn only corrected JSON.`;

    const runResult = await Result.tryPromise({
      try: () => input.run(prompt, { mode, providerSessionId }),
      catch: (cause) => classifyAgentProviderError(input.provider, cause),
    });
    if (runResult.isErr()) {
      if (
        mode === "native" &&
        isProviderSchemaUnsupportedError(runResult.error) &&
        attempt < maxRetries
      ) {
        input.onRetry?.({
          attempt: attempt + 1,
          errors: runResult.error.message,
          mode,
        });
        continue;
      }
      return runResult;
    }
    const result = runResult.value;
    providerSessionId = result.providerSessionId ?? providerSessionId;

    const candidates = structuredCandidates(result);
    if (candidates.length === 0) {
      lastFailure = new InvalidAgentJsonError({
        attempt: attempt + 1,
        mode,
        responseExcerpt: result.finalResponse.slice(0, 500),
      });
      if (attempt < maxRetries) {
        input.onRetry?.({ attempt: attempt + 1, errors: lastFailure.message, mode });
      }
      continue;
    }

    for (const candidate of candidates) {
      const ok = validate(candidate);
      if (ok) {
        return Result.ok({
          value: candidate,
          finalResponse: result.finalResponse,
          providerSessionId,
          attempts: attempt + 1,
          mode,
        });
      }
    }

    lastFailure = new AgentSchemaValidationError({
      attempt: attempt + 1,
      mode,
      issues: toSchemaIssues(validate.errors),
    });
    if (attempt < maxRetries) {
      input.onRetry?.({ attempt: attempt + 1, errors: lastFailure.message, mode });
    }
  }

  return Result.err(
    new SchemaRetriesExhaustedError(
      maxRetries + 1,
      lastFailure ??
        new InvalidAgentJsonError({
          attempt: maxRetries + 1,
          mode: native ? "native" : "prompt",
          responseExcerpt: "",
        }),
    ),
  );
}

export function augmentPromptForSchema(prompt: string, schema: JsonSchema): string {
  return [
    prompt,
    "",
    "Respond with ONLY a JSON value that validates against this JSON Schema (no markdown, no prose):",
    JSON.stringify(schema),
  ].join("\n");
}

export function formatAjvErrors(
  errors: Array<{ instancePath?: string; message?: string }> | null | undefined,
): string {
  if (!errors || errors.length === 0) return "validation failed";
  return errors
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "invalid"}`.trim();
    })
    .join("; ");
}

function toSchemaIssues(
  errors: Array<{ instancePath?: string; message?: string }> | null | undefined,
): Array<{ path: string; message: string }> {
  if (!errors || errors.length === 0) {
    return [{ path: "/", message: "validation failed" }];
  }
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "invalid",
  }));
}

/** Helper for wiring into agent(): wrap a one-shot provider as retrying schema runner. */
export function schemaAwareRunProvider(
  runProvider: WorkflowRunProvider,
  schema: JsonSchema,
  base: Parameters<WorkflowRunProvider>[0],
  onRetry?: EnforceSchemaInput["onRetry"],
): Promise<EnforceSchemaResult> {
  return enforceAgentSchema({
    schema,
    prompt: base.prompt,
    provider: base.provider,
    onRetry,
    run: (prompt, options) =>
      runProvider({
        ...base,
        prompt,
        providerSessionId: options.providerSessionId,
        ...(options.mode === "native" ? { schema } : {}),
      }),
  });
}

export function schemaAwareRunProviderResult(
  runProvider: WorkflowRunProvider,
  schema: JsonSchema,
  base: Parameters<WorkflowRunProvider>[0],
  onRetry?: EnforceSchemaInput["onRetry"],
): Promise<BetterResult<EnforceSchemaResult, EnforceSchemaError>> {
  return enforceAgentSchemaResult({
    schema,
    prompt: base.prompt,
    provider: base.provider,
    onRetry,
    run: (prompt, options) =>
      runProvider({
        ...base,
        prompt,
        providerSessionId: options.providerSessionId,
        ...(options.mode === "native" ? { schema } : {}),
      }),
  });
}

function structuredCandidates(result: WorkflowProviderRunResult): JsonValue[] {
  const candidates: JsonValue[] = [];
  if (result.structured !== undefined) {
    const structured = jsonValueSchema.safeParse(result.structured);
    if (structured.success) candidates.push(structured.data);
    if (typeof result.structured === "string") {
      const parsed = tryExtractJson(result.structured);
      const parsedJson = jsonValueSchema.safeParse(parsed);
      if (parsedJson.success && parsedJson.data !== result.structured) {
        candidates.push(parsedJson.data);
      }
    }
  }
  const fromText = tryExtractJson(result.finalResponse);
  const textJson = jsonValueSchema.safeParse(fromText);
  if (textJson.success) candidates.push(textJson.data);
  return candidates;
}
