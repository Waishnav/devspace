import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { enabledV11ToolNames } from "./register-v11-tools.js";

const baseEnv = {
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.deepEqual(enabledV11ToolNames(loadConfig(baseEnv)), []);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_SKILL_MATCHER: "1",
    DEVSPACE_COMPOUND_TOOLS: "1",
    DEVSPACE_DESIGN_AUDIT: "1",
  })),
  ["match_skills", "project_snapshot", "focused_context", "review_changes", "design_audit"],
);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_SKILL_MATCHER: "1",
    DEVSPACE_SKILLS: "0",
  })),
  [],
);
