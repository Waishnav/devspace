import assert from "node:assert/strict";
import {
  DEFAULT_INLINE_OUTPUT_CHARACTERS,
  createOutputPreview,
  outputMetadata,
  outputReceiptText,
} from "./tool-output.js";

assert.equal(DEFAULT_INLINE_OUTPUT_CHARACTERS, 12_000);

const complete = createOutputPreview("alpha\nbeta\n", 100);
assert.deepEqual(complete, {
  text: "alpha\nbeta\n",
  originalCharacters: 11,
  originalLines: 2,
  inlineCharacters: 11,
  omittedCharacters: 0,
  truncated: false,
});
assert.match(outputReceiptText(complete), /Complete output is included/);

const large = "HEAD-" + "x".repeat(20_000) + "-TAIL";
const preview = createOutputPreview(large, 1_000);
assert.equal(preview.truncated, true);
assert.equal(preview.originalCharacters, 20_010);
assert.equal(preview.inlineCharacters, 1_000);
assert.equal(Array.from(preview.text).length, 1_000);
assert.ok(preview.text.startsWith("HEAD-"));
assert.ok(preview.text.endsWith("-TAIL"));
assert.match(preview.text, /DevSpace inline preview truncated/);
assert.equal(
  preview.omittedCharacters,
  preview.originalCharacters -
    (preview.inlineCharacters - Array.from("\n... DevSpace inline preview truncated; narrow the command or read a smaller range to retrieve more ...\n").length),
);
assert.match(outputReceiptText(preview, "Process exited with code 0."), /bounded head\/tail preview/);
assert.match(outputReceiptText(preview, "Process exited with code 0."), /Process exited with code 0/);
assert.deepEqual(outputMetadata(preview), {
  outputCharacters: 20_010,
  outputLines: 1,
  inlineOutputCharacters: 1_000,
  inlineOutputTruncated: true,
  omittedOutputCharacters: preview.omittedCharacters,
});

const unicode = createOutputPreview("🙂".repeat(50), 20);
assert.equal(unicode.originalCharacters, 50);
assert.equal(unicode.inlineCharacters, 20);
assert.equal(Array.from(unicode.text).length, 20);
assert.equal(unicode.truncated, true);

const rawOutput = "z".repeat(50_000);
const boundedPayloadPreview = createOutputPreview(rawOutput, 12_000);
const oldPayloadSize = JSON.stringify({
  content: [{ type: "text", text: rawOutput }],
  structuredContent: { result: rawOutput },
  _meta: { card: { payload: { content: [{ type: "text", text: rawOutput }] } } },
}).length;
const newPayloadSize = JSON.stringify({
  content: [{ type: "text", text: boundedPayloadPreview.text }],
  structuredContent: {
    result: outputReceiptText(boundedPayloadPreview),
    ...outputMetadata(boundedPayloadPreview),
  },
  _meta: {
    card: {
      payload: { content: [{ type: "text", text: boundedPayloadPreview.text }] },
    },
  },
}).length;
assert.ok(oldPayloadSize > 150_000);
assert.ok(newPayloadSize < 30_000);
assert.ok(newPayloadSize < oldPayloadSize / 4);

assert.throws(
  () => createOutputPreview("output", 0),
  /Inline output limit must be a positive integer/,
);
