import * as z from "zod/v4";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

export function isJsonString(value: unknown): value is string {
  return z.string().safeParse(value).success;
}

export function isJsonNumber(value: unknown): value is number {
  return z.number().safeParse(value).success;
}

export function isJsonBoolean(value: unknown): value is boolean {
  return z.boolean().safeParse(value).success;
}

export function isBigintValue(value: unknown): value is bigint {
  return z.bigint().safeParse(value).success;
}

export function isSymbolValue(value: unknown): value is symbol {
  return z.symbol().safeParse(value).success;
}

export function isFunctionValue(value: unknown): value is (...args: never[]) => unknown {
  return z.function().safeParse(value).success;
}

export function parseJsonValue(value: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(value));
}

export function optionalFields<T extends object>(value: T | undefined): T | { readonly [key: string]: never } {
  if (value === undefined) return {};

  return value;
}

export function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  const result: { [P in K]?: V } = {};

  if (value !== undefined) result[key] = value;

  return result;
}

export function jsonObject(value: JsonValue, label: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);

  if (!parsed.success) throw new TypeError(`${label} must be a JSON object.`);

  return parsed.data;
}
