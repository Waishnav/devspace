import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript } from "./workflow-script.js";

test("a script without meta gets default metadata", () => {
  assert.deepEqual(parseWorkflowScript("return args;"), {
    meta: { name: "workflow", concurrency: 4 },
    body: "return args;",
  });
});

test("an exported meta object is parsed and stripped from the body", () => {
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
});

test("meta accepts quoted keys", () => {
  assert.deepEqual(
    parseWorkflowScript(`export const meta = { "name": "quoted" }; return 1;`).meta,
    { name: "quoted", concurrency: 4 },
  );
});

test("meta may follow leading comments", () => {
  const commented = parseWorkflowScript(`// @ts-check
/* workflow metadata */
export const meta = { name: "commented" }; return 1;`);
  assert.equal(commented.meta.name, "commented");
  assert.equal(commented.body.trim(), "return 1;");
});

// Long whitespace runs that do not lead to a meta declaration must fail fast (no regex backtracking blowup).
test("the meta prefix scan is linear in leading whitespace and comments", () => {
  const slowStart = Date.now();
  for (const filler of [" ", "\n", "\r\n", " //a\n"]) {
    const source = `${filler.repeat(5_000)}return 1;`;
    assert.equal(parseWorkflowScript(source).body, source);
  }
  assert.ok(Date.now() - slowStart < 1_000, "meta prefix scan must be linear");
  assert.equal(parseWorkflowScript(`${" ".repeat(5_000)}export const meta = { name: "late" }; return 1;`).meta.name, "late");
});

test("meta rejects non-literal values, unknown fields, out-of-range concurrency, and duplicates", () => {
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
});
