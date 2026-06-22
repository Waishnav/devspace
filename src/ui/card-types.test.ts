import assert from "node:assert/strict";
import {
  isEditTool,
  isShellTool,
  isToolName,
} from "./card-types.js";

for (const tool of ["apply_patch", "exec_command", "write_stdin"]) {
  assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
}

assert.equal(isEditTool("apply_patch"), true);
assert.equal(isShellTool("exec_command"), true);
assert.equal(isShellTool("write_stdin"), true);
assert.equal(isEditTool("exec_command"), false);
assert.equal(isShellTool("apply_patch"), false);
