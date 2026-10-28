import { isObjectValue, isJsonString } from "./json-value.js";
import type { WireInput, JsonObject } from "./json-value.js";

function metadataString(
  meta: WireInput,
  key: string,
): string | undefined {
  if (!isObjectValue(meta) || meta === null) return undefined;
  // SAFETY: The surrounding checks or construction already match this type.
  const value = (meta as JsonObject)[key];

  return isJsonString(value) && value.length > 0 ? value : undefined;
}

export function conversationScopeIdFromRequestMeta(
  meta: WireInput,
): string | undefined {
  return metadataString(meta, "openai/session");
}
