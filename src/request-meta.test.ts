import assert from "node:assert/strict";
import test from "node:test";
import { openAiConversationScopeId } from "./request-meta.js";

test("OpenAI conversation scope accepts only a non-empty session string", () => {
  for (const meta of [
    undefined,
    {},
    { "openai/session": "" },
    { "openai/session": 42 },
    { "openai/session": {} },
  ]) {
    assert.equal(openAiConversationScopeId(meta), undefined);
  }

  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});
