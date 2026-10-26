import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowsEnabled } from "./workflow-flag.js";

test("workflows are enabled only by DEVSPACE_EXPERIMENTAL_WORKFLOWS=1", () => {
  assert.equal(workflowsEnabled({}), false);
  assert.equal(workflowsEnabled({ DEVSPACE_EXPERIMENTAL_WORKFLOWS: "0" }), false);
  assert.equal(workflowsEnabled({ DEVSPACE_EXPERIMENTAL_WORKFLOWS: "true" }), false);
  assert.equal(workflowsEnabled({ DEVSPACE_EXPERIMENTAL_WORKFLOWS: "1" }), true);
});
