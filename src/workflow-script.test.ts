import assert from "node:assert/strict";
import { parseWorkflowScript } from "./workflow-script.js";

assert.deepEqual(parseWorkflowScript("return args;"), {
  meta: { name: "workflow", concurrency: 4 },
  body: "return args;",
});

const parsed = parseWorkflowScript(`
  export const meta = {
    name: 'review-files',
    description: "Review\\nfiles",
    concurrency: 8,
  };
  return args;
`);
assert.deepEqual(parsed.meta, {
  name: "review-files",
  description: "Review\nfiles",
  concurrency: 8,
});
assert.match(parsed.body, /return args/);

assert.deepEqual(
  parseWorkflowScript(`export const meta = { "name": "quoted" }; return 1;`).meta,
  { name: "quoted", concurrency: 4 },
);
assert.throws(
  () => parseWorkflowScript("export const meta = { name: getName() }; return 1;"),
  /must be strings or numbers/,
);
assert.throws(
  () => parseWorkflowScript("export const meta = { unknown: 'value' }; return 1;"),
  /Unknown workflow metadata field/,
);
assert.throws(
  () => parseWorkflowScript("export const meta = { concurrency: 17 }; return 1;"),
  /between 1 and 16/,
);
assert.throws(
  () => parseWorkflowScript("export const meta = { name: 'a', name: 'b' }; return 1;"),
  /Duplicate workflow metadata field/,
);
