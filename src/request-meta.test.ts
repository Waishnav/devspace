import assert from "node:assert/strict";
import test from "node:test";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";

test("conversation scope resolves valid OpenAI session metadata", () => {
  for (const meta of [
    undefined,
    {},
    { "openai/session": "" },
    { "openai/session": 42 },
    { "openai/session": {} },
  ]) {
    assert.equal(conversationScopeIdFromRequestMeta(meta), undefined);
  }

  assert.equal(
    conversationScopeIdFromRequestMeta({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});
