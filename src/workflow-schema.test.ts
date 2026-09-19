import assert from "node:assert/strict";
import {
  assertJsonValue,
  parseStructuredOutput,
  validateSchemaBounds,
  validateJsonSchema,
  validateStructuredOutput,
  workflowWorkerUrl,
} from "./workflow-schema.js";
import type { JsonSchema } from "./workflow-types.js";

let getterCalled = false;
const accessor = Object.defineProperty({}, "secret", {
  enumerable: true,
  get() { getterCalled = true; return "bad"; },
});
assert.throws(() => assertJsonValue(accessor), /accessors/);
assert.equal(getterCalled, false);

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
assert.throws(() => assertJsonValue(cyclic), /cycles/);
assert.throws(() => assertJsonValue([, 1]), /dense/);
assert.throws(() => assertJsonValue({ value: Number.NaN }), /finite/);

assert.deepEqual(parseStructuredOutput('{"ok":true}'), { ok: true });
assert.deepEqual(parseStructuredOutput('```json\n{"ok":true}\n```'), { ok: true });
assert.throws(() => parseStructuredOutput('result: {"ok":true}'));
assert.throws(() => validateSchemaBounds({ properties: { deep: { properties: {} } } }, 1_000, 2));
assert.equal(workflowWorkerUrl("file:///source/workflow-schema.ts").href, "file:///source/workflow-worker.ts");
assert.equal(workflowWorkerUrl("file:///dist/workflow-schema.js").href, "file:///dist/workflow-worker.js");

const schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: { row: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
  $ref: "#/$defs/row",
};
assert.equal((await validateStructuredOutput(schema, { ok: true })).valid, true);
await validateJsonSchema(schema);
await assert.rejects(validateJsonSchema({ type: "not-a-json-schema-type" }), /must be equal to one of the allowed values/i);
const invalid = await validateStructuredOutput(schema, { ok: "yes" });
assert.equal(invalid.valid, false);
assert(invalid.errors?.length);
assert.equal((await validateStructuredOutput({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "array",
  items: { type: "integer" },
}, [1, 2])).valid, true);

await assert.rejects(
  validateStructuredOutput({ $ref: "https://example.com/schema.json" }, {}),
  /can't resolve reference|resolve reference/i,
);
await assert.rejects(
  validateStructuredOutput({
    type: "object",
    required: ["missing"],
    properties: {},
    additionalProperties: false,
  }, {}),
  /Required property 'missing'/,
);

let deepSchema: JsonSchema = { type: "string" };
for (let depth = 0; depth < 65; depth++) deepSchema = { allOf: [deepSchema] };
await assert.rejects(validateStructuredOutput(deepSchema, "ok"), /exceeds depth 64/);
assert.equal((await validateStructuredOutput(deepSchema, "ok", { maxDepth: 140 })).valid, true,
  "structured validation honors the configured schema depth used at compile time");
