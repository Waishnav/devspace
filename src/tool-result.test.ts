import assert from "node:assert/strict";
import { contentStats, contentText, textContent, toolError } from "./tool-result.js";

assert.deepEqual(textContent("hello"), [{ type: "text", text: "hello" }]);
assert.equal(contentText([{ type: "text", text: "hello" }, { type: "text", text: "world" }]), "hello\nworld");
assert.deepEqual(contentStats([{ type: "text", text: "hello\nworld" }]), { lines: 2, characters: 11 });
assert.equal(toolError("nope").isError, true);
