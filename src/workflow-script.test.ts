import assert from "node:assert/strict";
import { parseWorkflowScript, renameWorkflowMeta, WorkflowScriptError } from "./workflow-script.js";

const valid = `// leading comment
export const meta = {
  name: 'review-code',
  description: "Review\\ncode",
  phases: [{ title: 'Review', detail: 'Inspect changes' }],
}
return args
`;
const parsed = parseWorkflowScript(valid);
assert.equal(parsed.meta.name, "review-code");
assert.equal(parsed.meta.description, "Review\ncode");
assert.equal(parsed.body.split("\n").length, valid.split("\n").length);
assert.match(parsed.body, /return args/);
assert.doesNotMatch(parsed.body, /export const meta/);

const renamed = renameWorkflowMeta(valid, "verify-code");
assert.equal(parseWorkflowScript(renamed).meta.name, "verify-code");
assert.match(renamed, /description: "Review\\ncode"/);
const parenthesized = `export const meta = ({ name: 'old-name', description: 'Parenthesized' })\nreturn null`;
const renamedParenthesized = renameWorkflowMeta(parenthesized, "new-name");
assert.equal(parseWorkflowScript(renamedParenthesized).meta.name, "new-name");

for (const source of [
  `export const meta = makeMeta()\nreturn null`,
  `export const meta = {name:'x', name:'y', description:'d'}\nreturn null`,
  `export const meta = {['name']:'x', description:'d'}\nreturn null`,
  `export const meta = {name:'x', description:'d', __proto__: null}\nreturn null`,
  `export const meta = {name:'x', description:'d'}\nexport const other = 1`,
  `export const meta = {name:'x', description:'d'}\nawait import('./x.js')`,
]) {
  assert.throws(() => parseWorkflowScript(source), WorkflowScriptError);
}

try {
  parseWorkflowScript(`export const meta = { name: 'x', description: }`);
  assert.fail("expected syntax error");
} catch (error) {
  assert(error instanceof WorkflowScriptError);
  assert.equal(error.code, "WORKFLOW_SYNTAX_ERROR");
  assert.equal(error.location?.line, 1);
}
