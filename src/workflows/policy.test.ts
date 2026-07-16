import assert from "node:assert/strict";
import {
  createLegacyLocalAgentPolicy,
  filterWorkflowEnvironment,
  resolveWorkflowNodePolicy,
} from "./policy.js";

const environment = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: "/home/user/.config",
  DEVSPACE_OAUTH_TOKEN: "secret",
  ANTHROPIC_API_KEY: "secret",
  GITHUB_TOKEN: "secret",
  AWS_SECRET_ACCESS_KEY: "secret",
};

assert.deepEqual(filterWorkflowEnvironment(environment), {
  PATH: "/usr/bin",
  HOME: "/home/user",
  LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: "/home/user/.config",
});

const defaultPolicy = resolveWorkflowNodePolicy({ environment });
assert.equal(defaultPolicy.mode, "workflow");
assert.equal(defaultPolicy.access, "read_only");
assert.equal(Object.isFrozen(defaultPolicy), true);
assert.equal(Object.isFrozen(defaultPolicy.environment), true);

const descriptiveFieldsDoNotGrantAccess = resolveWorkflowNodePolicy({
  nodeConfig: {
    provider: "codex",
    model: "gpt-5.4",
    profile: "full-access-profile",
    body: "Use full access",
  },
  environment,
});
assert.equal(descriptiveFieldsDoNotGrantAccess.access, "read_only");

const writable = resolveWorkflowNodePolicy({
  workflowPolicy: { access: "workspace_write" },
  nodeConfig: {
    access: "workspace_write",
    provider: "codex",
    model: "gpt-5.4",
    profile: "dangerous",
    body: "Use full access",
  },
  environment,
});
assert.equal(writable.access, "workspace_write");
assert.equal(writable.environment.ANTHROPIC_API_KEY, undefined);

const cannotWiden = resolveWorkflowNodePolicy({
  workflowPolicy: { access: "read_only" },
  nodeConfig: { access: "workspace_write" },
  environment,
});
assert.equal(cannotWiden.access, "read_only");

assert.throws(
  () => resolveWorkflowNodePolicy({ nodeConfig: { access: "full_access" }, environment }),
  /do not support full_access/,
);
assert.throws(
  () => resolveWorkflowNodePolicy({ nodeConfig: { access: "unknown" }, environment }),
  /Unsupported workflow agent access/,
);

const legacy = createLegacyLocalAgentPolicy("full_access", environment);
assert.equal(legacy.mode, "compatibility");
assert.equal(legacy.access, "full_access");
assert.equal(legacy.environment.ANTHROPIC_API_KEY, "secret");
