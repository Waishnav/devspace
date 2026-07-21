import { createRequire } from "node:module";
import { WORKFLOW_MAX_SCHEMA_RETRIES } from "./workflow-types.js";
import { tryExtractJson, WorkflowEngineError } from "./workflow-api.js";
import type { WorkflowProviderRunResult, WorkflowRunProvider } from "./workflow-api.js";

const require = createRequire(import.meta.url);

type AjvLike = new (opts?: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & {
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

export interface EnforceSchemaInput {
  schema: object;
  prompt: string;
  run: (prompt: string) => Promise<WorkflowProviderRunResult>;
  onRetry?: (info: { attempt: number; errors: string }) => void;
  maxRetries?: number;
}

export interface EnforceSchemaResult {
  value: unknown;
  finalResponse: string;
  providerSessionId?: string;
  attempts: number;
}

/**
 * Augment prompt → run → extract JSON → Ajv validate → retry ≤2.
 */
export async function enforceAgentSchema(
  input: EnforceSchemaInput,
): Promise<EnforceSchemaResult> {
  const Ajv = loadAjv();
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(input.schema);
  const maxRetries = input.maxRetries ?? WORKFLOW_MAX_SCHEMA_RETRIES;
  const basePrompt = augmentPromptForSchema(input.prompt, input.schema);

  let lastResponse = "";
  let lastSession: string | undefined;
  let lastErrors = "unknown validation error";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nPrevious JSON failed validation:\n${lastErrors}\nReturn only corrected JSON.`;

    const result = await input.run(prompt);
    lastResponse = result.finalResponse;
    lastSession = result.providerSessionId ?? lastSession;

    const extracted = tryExtractJson(result.finalResponse);
    if (extracted === undefined) {
      lastErrors = "Response was not valid JSON";
      input.onRetry?.({ attempt: attempt + 1, errors: lastErrors });
      continue;
    }

    const ok = validate(extracted);
    if (ok) {
      return {
        value: extracted,
        finalResponse: result.finalResponse,
        providerSessionId: result.providerSessionId,
        attempts: attempt + 1,
      };
    }

    lastErrors = formatAjvErrors(validate.errors);
    input.onRetry?.({ attempt: attempt + 1, errors: lastErrors });
  }

  throw new WorkflowEngineError(
    "schema",
    `Schema validation failed after ${maxRetries + 1} attempts: ${lastErrors}`,
  );
}

export function augmentPromptForSchema(prompt: string, schema: object): string {
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

/** Helper for wiring into agent(): wrap a one-shot provider as retrying schema runner. */
export function schemaAwareRunProvider(
  runProvider: WorkflowRunProvider,
  schema: object,
  base: Parameters<WorkflowRunProvider>[0],
  onRetry?: EnforceSchemaInput["onRetry"],
): Promise<EnforceSchemaResult> {
  return enforceAgentSchema({
    schema,
    prompt: base.prompt,
    onRetry,
    run: (prompt) =>
      runProvider({
        ...base,
        prompt,
      }),
  });
}
