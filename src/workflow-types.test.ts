import assert from "node:assert/strict";
import {
  WORKFLOW_MAX_ITEMS,
  WORKFLOW_MAX_NEST_DEPTH,
  buildAgentCacheKeyInput,
  createStubBudget,
  defaultWorkflowConcurrency,
  resolveWorkflowConcurrency,
} from "./workflow-types.js";

assert.equal(WORKFLOW_MAX_ITEMS, 4096);
assert.equal(WORKFLOW_MAX_NEST_DEPTH, 1);

assert.deepEqual(
  buildAgentCacheKeyInput({
    prompt: "hi",
    provider: "codex",
    model: undefined,
    effort: "high",
    schema: null,
    isolation: "worktree",
  }),
  {
    prompt: "hi",
    provider: "codex",
    model: null,
    effort: "high",
    schema: null,
    isolation: "worktree",
  },
);

assert.deepEqual(
  buildAgentCacheKeyInput({
    prompt: "x",
    provider: "claude",
  }),
  {
    prompt: "x",
    provider: "claude",
    model: null,
    effort: null,
    schema: null,
    isolation: "shared",
  },
);

const budget = createStubBudget();
assert.equal(budget.total, null);
assert.equal(budget.spent(), 0);
assert.equal(budget.remaining(), Infinity);

assert.equal(defaultWorkflowConcurrency(8), 6);
assert.equal(defaultWorkflowConcurrency(2), 1);
assert.equal(defaultWorkflowConcurrency(1), 1);
assert.equal(defaultWorkflowConcurrency(32), 16);

assert.equal(resolveWorkflowConcurrency(undefined, 8), 6);
assert.equal(resolveWorkflowConcurrency(2, 8), 2);
assert.equal(resolveWorkflowConcurrency(100, 8), 6);
assert.equal(resolveWorkflowConcurrency(0, 8), 1);

console.log("workflow-types.test.ts: ok");
