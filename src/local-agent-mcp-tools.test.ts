import assert from "node:assert/strict";
import type { ServerConfig } from "./config.js";
import { createLocalAgentMcpCapability, verifyLocalAgentMcpCapability } from "./local-agent-mcp-capability.js";
import { localAgentMcpLaunch, writeModeAtMost } from "./local-agent-mcp-launch.js";
import { authorizeWriteMode, registerLocalAgentMcpTools } from "./local-agent-mcp-tools.js";

const names: string[] = [];
const target = {
  registerTool(name: string): void { names.push(name); },
} as never;
const config = {
  configDir: "/tmp/devspace-config",
  stateDir: "/tmp/devspace-state",
  subagents: { enabled: true, providers: [] },
} as unknown as ServerConfig;

registerLocalAgentMcpTools(target, {
  config,
  resolveScope: async (workspaceId) => ({ workspaceId, workspaceRoot: "/tmp/project" }),
});
assert.deepEqual(names, [
  "agent_targets",
  "agent_spawn",
  "agent_send",
  "agent_status",
  "agent_wait",
  "agent_cancel",
  "agent_list",
]);

assert.equal(authorizeWriteMode(undefined, "read_only").value, "read_only");
assert.equal(authorizeWriteMode(undefined, "allowed").value, "allowed");
assert.equal(authorizeWriteMode("read_only", "full_access").value, "read_only");
assert.equal(authorizeWriteMode("full_access", "allowed").error?.code, "AGENT_AUTHORITY_ESCALATION");
assert.equal(writeModeAtMost("read_only", "allowed"), true);
assert.equal(writeModeAtMost("full_access", "allowed"), false);

const capability = createLocalAgentMcpCapability("secret", {
  parentAgentId: "agt_parent",
  workspaceId: "ws_parent",
  workspaceRoot: "/tmp/project",
  maxWriteMode: "allowed",
});
assert.equal(verifyLocalAgentMcpCapability("secret", capability).maxWriteMode, "allowed");
assert.throws(() => verifyLocalAgentMcpCapability("other-secret", capability));

const launch = localAgentMcpLaunch({
  agentId: "agt_parent",
  workspaceId: "ws_parent",
  workspaceRoot: "/tmp/project",
  writeMode: "allowed",
  mcpCapability: capability,
}, { DEVSPACE_CONFIG_DIR: "/tmp/devspace-config" });
assert.equal(launch?.name, "devspace-agents-agt_parent");
assert.deepEqual(launch?.env, {
  DEVSPACE_CONFIG_DIR: "/tmp/devspace-config",
  DEVSPACE_AGENT_MCP_CAPABILITY: capability,
});
assert.equal(localAgentMcpLaunch({
  agentId: "agt_parent",
  workspaceRoot: "/tmp/project",
  writeMode: "allowed",
}), undefined);
