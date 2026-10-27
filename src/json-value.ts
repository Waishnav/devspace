import * as z from "zod/v4";

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- JSON objects are an open string-keyed map by contract.
export type JsonObject = { [key: string]: JsonField | WireInput };

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- JSON values include nested objects with string keys.
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export type JsonField = JsonValue | undefined;

/** Parsed-or-unparsed input that TypeScript can accept from object literals, Errors, and SDK handles. */
export type WireInput = {} | null | undefined;

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

// SAFETY: Runtime JSON objects are a subset of the mutable host dictionary type.
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema) as z.ZodType<JsonObject>;

export function isErrorValue<T>(value: T): value is T & Error {
  return value instanceof Error;
}

export function isJsonValue<T>(value: T): value is T & JsonValue {
  return jsonValueSchema.safeParse(value).success;
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

export function isJsonString<T>(value: T): value is T & string {
  return z.string().safeParse(value).success;
}

export function isJsonNumber<T>(value: T): value is T & number {
  return z.number().safeParse(value).success;
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
  return z.boolean().safeParse(value).success;
}

export function isBigintValue<T>(value: T): value is T & bigint {
  return z.bigint().safeParse(value).success;
}

export function isSymbolValue<T>(value: T): value is T & symbol {
  return z.symbol().safeParse(value).success;
}

export function isFunctionValue(value: WireInput): value is (...args: never[]) => void {
  return z.function().safeParse(value).success;
}

/** Same labels as `typeof`, for log and error text after a value has been classified. */
export function jsonKind(value: WireInput): string {
  if (value === undefined) return "undefined";

  if (isJsonString(value)) return "string";

  if (isJsonNumber(value)) return "number";

  if (isJsonBoolean(value)) return "boolean";

  if (isBigintValue(value)) return "bigint";

  if (isSymbolValue(value)) return "symbol";

  if (isFunctionValue(value)) return "function";

  return "object";
}

export function isObjectValue<T>(value: T): value is T & object {
  return value !== null && value !== undefined && Object(value) === value && !z.function().safeParse(value).success;
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
) {
  const result: { [P in K]?: V } = {};

  if (value !== undefined) result[key] = value;

  return result;
}

export function jsonObject(value: {} | null | undefined, label: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);

  if (!parsed.success) throw new TypeError(`${label} must be a JSON object.`);

  return parsed.data;
}
