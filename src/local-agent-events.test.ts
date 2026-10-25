import assert from "node:assert/strict";
import {
  providerErrorDetail,
  redactSecrets,
  sanitizeActivityEvent,
  summarizeToolInput,
} from "./local-agent-events.js";

assert.equal(redactSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123"), "token: [redacted]");
assert.equal(redactSecrets("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu"), "export OPENAI_API_KEY=[redacted]");
assert.equal(redactSecrets("deploy --password hunter2 --verbose"), "deploy --password [redacted] --verbose");
assert.equal(redactSecrets("gh auth login --with-token 'abc def'"), "gh auth login --with-token [redacted]");
assert.equal(redactSecrets("docker login --password-stdin"), "docker login --password-stdin");
assert.equal(redactSecrets("pnpm test --max-tokens 4096"), "pnpm test --max-tokens 4096");
assert.equal(redactSecrets("deploy --github-token ghx_value"), "deploy --github-token [redacted]");
assert.equal(redactSecrets("curl -H 'Bearer abcdefghijkl'"), "curl -H 'Bearer [redacted]'");
assert.equal(redactSecrets("git status --short"), "git status --short");

assert.equal(summarizeToolInput({ command: "pnpm test", timeout: 10 }), "pnpm test");
assert.equal(summarizeToolInput({ command: ["git", "diff"] }), "git diff");
assert.equal(summarizeToolInput({ file_path: "src/a.ts", content: "x" }), "src/a.ts");
assert.equal(summarizeToolInput({ unknown: true }), undefined);

const longSummary = sanitizeActivityEvent({ type: "tool_started", tool: "bash", summary: `echo ${"x".repeat(500)}\nnext` });
assert.equal(longSummary?.type === "tool_started" && longSummary.summary?.length, 200);
assert.equal(sanitizeActivityEvent({ type: "message", text: " \n " }), undefined);

assert.equal(
  providerErrorDetail({ message: "Pi agent turn failed.", cause: new Error("429 rate limited") }),
  "429 rate limited",
);
assert.equal(
  providerErrorDetail({ message: "Same.", cause: new Error("Same.", { cause: "nested reason" }) }),
  "nested reason",
);
assert.equal(providerErrorDetail({ message: "No cause." }), undefined);
