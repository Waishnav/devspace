import assert from "node:assert/strict";
import {
  codexTurnMetadataForChromeUse,
  codexTurnMetadataForComputerUse,
  codexConversationKey,
  createLocalCodexTurnMetadata,
  extractAuthenticCodexTurnMetadata,
} from "./codex-request-context.js";

const authentic = {
  session_id: "session-real",
  turn_id: "turn-real",
  thread_source: "chatgpt",
};
assert.deepEqual(
  extractAuthenticCodexTurnMetadata({ "x-codex-turn-metadata": authentic }),
  authentic,
);
assert.equal(
  extractAuthenticCodexTurnMetadata({
    "x-codex-turn-metadata": { session_id: "session-only" },
  }),
  undefined,
);
assert.equal(extractAuthenticCodexTurnMetadata(undefined), undefined);

const firstLocal = createLocalCodexTurnMetadata({
  requestMeta: { "openai/session": "openai-session-value" },
  requestId: 1,
});
const secondLocal = createLocalCodexTurnMetadata({
  requestMeta: { "openai/session": "openai-session-value" },
  requestId: 2,
});
assert.equal(firstLocal.session_id, secondLocal.session_id);
assert.notEqual(firstLocal.turn_id, secondLocal.turn_id);
assert.match(firstLocal.session_id, /^devspace_[0-9a-f]{32}$/u);
assert.match(firstLocal.turn_id, /^request_[0-9a-f]{32}$/u);

await assert.rejects(
  () => codexTurnMetadataForComputerUse(
    { requestMeta: { "openai/session": "session" }, requestId: 1 },
    { screenLocked: true },
  ),
  (error: unknown) => (
    error instanceof Error
    && "code" in error
    && error.code === "codex_computer_use_locked_context_unavailable"
  ),
);

assert.deepEqual(
  await codexTurnMetadataForComputerUse(
    { requestMeta: { "x-codex-turn-metadata": authentic }, requestId: 1 },
    { screenLocked: true },
  ),
  authentic,
);

const unlocked = await codexTurnMetadataForComputerUse(
  { requestMeta: { "openai/session": "session" }, requestId: 1 },
  { screenLocked: false },
);
assert.match(unlocked.session_id, /^devspace_/u);

const chromeLocked = codexTurnMetadataForChromeUse({
  requestMeta: { "openai/session": "session" },
  requestId: 1,
});
assert.match(chromeLocked.session_id, /^devspace_/u);

assert.equal(
  codexConversationKey({ requestMeta: { "x-codex-turn-metadata": authentic } }),
  "codex:session-real",
);
assert.equal(
  codexConversationKey({ requestMeta: { "openai/session": "same-conversation" } }),
  codexConversationKey({ requestMeta: { "openai/session": "same-conversation" } }),
);
assert.notEqual(
  codexConversationKey({ requestMeta: { "openai/session": "conversation-a" } }),
  codexConversationKey({ requestMeta: { "openai/session": "conversation-b" } }),
);
