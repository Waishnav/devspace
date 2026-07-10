import assert from "node:assert/strict";
import { platform } from "node:os";
import {
  appendUsageToContent,
  compactDuration,
  compactTokenCount,
  editInputChars,
  estimateTokensFromChars,
  getExecutionCostSnapshot,
  recordObservedToolUsage,
  textContentChars,
} from "./usage-meter.js";

assert.equal(estimateTokensFromChars(0), 0);
assert.equal(estimateTokensFromChars(5), 2);
assert.equal(compactTokenCount(999), "999");
assert.equal(compactTokenCount(1_500), "1.5k");
assert.equal(compactDuration(950), "950ms");
assert.equal(compactDuration(1_500), "1.5s");
assert.equal(editInputChars([{ oldText: "old", newText: "new" }]), 6);
assert.equal(textContentChars([{ type: "text", text: "hello" }]), 5);

const previousHistory = process.env.DEVSPACE_USAGE_HISTORY;
process.env.DEVSPACE_USAGE_HISTORY = platform() === "win32" ? "NUL" : "/dev/null";
const usage = recordObservedToolUsage({
  tool: "read",
  observedChars: 40,
  savedChars: 80,
  inputChars: 10,
  outputChars: 30,
  payloadChars: 40,
  durationMs: 125,
  error: false,
  retries: 1,
});
const content = [{ type: "text" as const, text: "result" }];

assert.equal(usage.durationMs, 125);
assert.equal(usage.sessionCalls >= 1, true);
assert.deepEqual(appendUsageToContent(content, usage, "off"), content);
const compactContent = appendUsageToContent(content, usage, "compact");
const compactText = compactContent.at(-1);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /DevSpace cost:/,
);
const fullContent = appendUsageToContent(content, usage, "full");
const fullText = fullContent.at(-1);
assert.match(
  fullText?.type === "text" ? fullText.text : "",
  /Execution cost estimate/,
);
const snapshot = getExecutionCostSnapshot();
assert.equal(snapshot.calls >= 1, true);
assert.equal(snapshot.byTool.read.calls >= 1, true);
assert.equal(snapshot.byTool.read.totalDurationMs >= 125, true);
assert.equal(snapshot.retries >= 1, true);

if (previousHistory === undefined) {
  delete process.env.DEVSPACE_USAGE_HISTORY;
} else {
  process.env.DEVSPACE_USAGE_HISTORY = previousHistory;
}
