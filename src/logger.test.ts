import assert from "node:assert/strict";
import test from "node:test";
import { commandPreview } from "./logger.js";

test("command previews redact common secret forms while preserving useful context", () => {
  const preview = commandPreview(
    "deploy --token abc123 --password=hidden API_KEY=key123 -authorization BearerToken curl -H 'Authorization: Bearer xyz789'",
  );

  assert.match(preview, /deploy/);
  assert.match(preview, /--token \[REDACTED\]/);
  assert.match(preview, /--password=\[REDACTED\]/);
  assert.match(preview, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(preview, /abc123|hidden|key123|xyz789/);
});
