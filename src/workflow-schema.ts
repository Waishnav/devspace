import { Worker } from "node:worker_threads";
import * as z from "zod/v4";
import type {
  AgentOptions,
  JsonSchema,
  JsonValue,
  StructuredOutputValidation,
  WorkflowMeta,
} from "./workflow-types.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const workflowMetaSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(2_000),
  whenToUse: z.string().max(2_000).optional(),
  phases: z.array(z.object({
    title: z.string().min(1).max(200),
    detail: z.string().max(2_000).optional(),
    model: z.string().trim().min(1).optional(),
  }).strict()).refine(
    (phases) => new Set(phases.map(({ title }) => title)).size === phases.length,
    "Phase titles must be unique.",
  ).optional(),
}).strict();

export const agentOptionsSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  phase: z.string().min(1).max(200).optional(),
  schema: jsonValueSchema.refine((value): value is JsonSchema => typeof value === "boolean"
    || (value !== null && !Array.isArray(value) && typeof value === "object"), "Expected a JSON Schema object or boolean.").optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  isolation: z.literal("worktree").optional(),
  agentType: z.string().trim().min(1).optional(),
}).strict();

export function validateWorkflowMeta(value: unknown): WorkflowMeta {
  return workflowMetaSchema.parse(value);
}

export function validateAgentOptions(value: unknown): AgentOptions {
  assertJsonValue(value, "Agent options");
  return agentOptionsSchema.parse(value);
}

export function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (Number.isFinite(item)) return;
      throw new TypeError(`${label} must contain finite numbers.`);
    }
    if (typeof item !== "object") throw new TypeError(`${label} must be JSON data.`);
    if (seen.has(item)) throw new TypeError(`${label} cannot contain cycles.`);
    seen.add(item);
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) {
      throw new TypeError(`${label} contains an unsupported object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError(`${label} cannot contain symbols.`);
    if (array) {
      if (keys.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(String(key)))) {
        throw new TypeError(`${label} arrays cannot have custom properties.`);
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label} arrays must be dense data properties.`);
        visit(descriptor.value);
      }
    } else {
      for (const key of keys as string[]) {
        if (["__proto__", "prototype", "constructor"].includes(key)) {
          throw new TypeError(`${label} contains a prototype-sensitive key.`);
        }
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor)) throw new TypeError(`${label} cannot contain accessors.`);
        visit(descriptor.value);
      }
    }
    seen.delete(item);
  };
  visit(value);
}

export function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function jsonDepth(value: JsonValue): number {
  if (value === null || typeof value !== "object") return 0;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.length === 0 ? 1 : 1 + Math.max(...values.map(jsonDepth));
}

export function validateSchemaBounds(schema: JsonSchema, maxBytes: number, maxDepth: number): void {
  assertJsonValue(schema, "JSON Schema");
  if (jsonByteLength(schema) > maxBytes) throw new Error(`Schema exceeds ${maxBytes} bytes.`);
  if (jsonDepth(schema) > maxDepth) throw new Error(`Schema exceeds depth ${maxDepth}.`);
}

export function parseStructuredOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  const value: unknown = JSON.parse(source);
  assertJsonValue(value, "Structured output");
  return value;
}

export async function validateStructuredOutput(
  schema: JsonSchema,
  value: JsonValue,
  options: { timeoutMs?: number; maxOldGenerationSizeMb?: number; maxBytes?: number; maxDepth?: number } = {},
): Promise<StructuredOutputValidation> {
  validateSchemaBounds(schema, options.maxBytes ?? 128 * 1024, options.maxDepth ?? 64);
  assertJsonValue(value, "Structured output");
  return runSchemaWorker({ schema, value }, options);
}

export async function validateJsonSchema(
  schema: JsonSchema,
  options: { timeoutMs?: number; maxOldGenerationSizeMb?: number; maxBytes?: number; maxDepth?: number } = {},
): Promise<void> {
  validateSchemaBounds(schema, options.maxBytes ?? 128 * 1024, options.maxDepth ?? 64);
  const result = await runSchemaWorker({ schema, compileOnly: true }, options);
  if (!result.valid) throw Object.assign(new Error("JSON Schema compilation failed."), { code: "SCHEMA_INVALID" });
}

async function runSchemaWorker(
  workerData: { schema: JsonSchema; value?: JsonValue; compileOnly?: boolean },
  options: { timeoutMs?: number; maxOldGenerationSizeMb?: number },
): Promise<StructuredOutputValidation> {
  const worker = new Worker(workflowWorkerUrl(), {
    workerData: { kind: "schema", ...workerData },
    resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? 32 },
  });
  const timeoutMs = options.timeoutMs ?? 2_000;
  return await new Promise<StructuredOutputValidation>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Object.assign(new Error("Schema validation timed out."), { code: "SCHEMA_VALIDATION_TIMEOUT" }));
    }, timeoutMs);
    worker.once("message", (message: StructuredOutputValidation & { error?: string; code?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(Object.assign(new Error(message.error), { code: message.code ?? "SCHEMA_INVALID" }));
      else resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function workflowWorkerUrl(moduleUrl = import.meta.url): URL {
  return new URL(moduleUrl.endsWith(".ts") ? "./workflow-worker.ts" : "./workflow-worker.js", moduleUrl);
}
