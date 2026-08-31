import type { JSONSchema } from "json-schema-to-ts";
import * as z from "zod/v4";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** JSON Schema is the portable contract shared with provider SDKs and Ajv. */
export type JsonSchema = JSONSchema;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

export const jsonSchemaSchema = jsonObjectSchema.transform(
  (value): JsonSchema => value as JsonSchema,
);

export function parseJsonValue(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}

export function parseJsonText(text: string): JsonValue {
  return parseJsonValue(JSON.parse(text) as unknown);
}
