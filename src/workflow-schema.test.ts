import assert from "node:assert/strict";
import { compileWorkflowSchema, parseWorkflowOutput } from "./workflow-schema.js";

const validate = compileWorkflowSchema({
  type: "object", properties: { summary: { type: "string" }, count: { type: "integer", minimum: 0 } },
  required: ["summary", "count"], additionalProperties: false,
});
assert.deepEqual(parseWorkflowOutput('{"summary":"ok","count":2}', validate), { summary: "ok", count: 2 });
assert.throws(() => parseWorkflowOutput('```json\n{}\n```', validate), /not JSON/);
assert.throws(() => parseWorkflowOutput('{"summary":"ok","count":-1}', validate), /JSON output/);
assert.throws(() => compileWorkflowSchema({ type: "not-a-type" }), /Invalid JSON schema/);
assert.throws(() => compileWorkflowSchema({ type: "string", pattern: "(a+)+$" }), /do not support pattern/);
assert.throws(() => compileWorkflowSchema({ $ref: "https://example.com/schema" }), /do not support \$ref/);
assert.throws(() => compileWorkflowSchema({ $async: true, type: "object" }), /do not support \$async/);
assert.doesNotThrow(() => compileWorkflowSchema({ type: "object", properties: { format: { type: "string" } } }));
console.log("Workflow structural schema validation checks passed.");
