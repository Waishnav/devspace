import type { RequestMeta } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const requestMetaSchema = z
  .object({ "openai/session": z.string().min(1).optional() })
  .passthrough();

export function conversationScopeIdFromRequestMeta(
  meta: RequestMeta | undefined,
): string | undefined {
  const parsed = requestMetaSchema.safeParse(meta);

  return parsed.success ? parsed.data["openai/session"] : undefined;
}
