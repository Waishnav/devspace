import { isJsonString, isJsonObject } from "./json-value.js";
import type { JsonObject, JsonValue } from "./json-value.js";
function metadataString(
  meta: JsonValue,
  key: string,
): string | undefined {
  if (!isJsonObject(meta) || meta === null) return undefined;
  // SAFETY: Boundary value already validated or constructed to match this type.
  const value = (meta as JsonObject)[key];

  return isJsonString(value) && value.length > 0 ? value : undefined;
}

export function conversationScopeIdFromRequestMeta(
  meta: JsonValue,
): string | undefined {
  return metadataString(meta, "openai/session");
}
