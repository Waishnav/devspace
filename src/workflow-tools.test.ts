import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { defaultWorkflowsConfig } from "./workflow-config.js";
import { parseWorkflowCli } from "./workflow-cli.js";
import { decodeWorkflowReply, decodeWorkflowRequest, type WorkflowRequest } from "./workflow-protocol.js";
import { registerWorkflowTools } from "./workflow-tools.js";

test("workflow MCP tools publish snake_case schemas and preserve arbitrary JSON argument keys", async (t) => {
  const server = new McpServer({ name: "workflow-test", version: "1" });
  const client = new Client({ name: "workflow-test-client", version: "1" });
  const requests: WorkflowRequest[] = [];
  registerWorkflowTools({
    server,
    config: { workflows: { ...defaultWorkflowsConfig(), enabled: true } } as ServerConfig,
    workspaces: { getWorkspace: async (id: string) => {
      assert.equal(id, "ws-test"); return { root: "/approved/project" };
    } } as WorkspaceRegistry,
    request: async (input) => { requests.push(input); return { ok: true, result: { runId: "run-test" } }; },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["control_workflow", "get_workflow", "list_workflows", "run_workflow", "save_workflow", "wait_workflow"]);
  for (const tool of tools) {
    assert.ok(Object.keys(tool.inputSchema.properties ?? {}).every((key) => /^[a-z][a-z0-9_]*$/.test(key)));
  }
  const result = await client.callTool({ name: "run_workflow", arguments: {
    workspace_id: "ws-test", script: "source", agent_type: "reviewer", args: { fileName: "example.ts" },
  } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests[0], { operation: "run", scope: { workspaceId: "ws-test", workspaceRoot: "/approved/project" },
    input: { script: "source", agentType: "reviewer", args: { fileName: "example.ts" } } });
  const invalid = await client.callTool({ name: "control_workflow", arguments: {
    workspace_id: "ws-test", run_id: "run-test", action: "restart_agent",
  } });
  assert.equal(invalid.isError, true);
  assert.equal(requests.length, 1);
});

test("workflow protocol and CLI reject invalid controls and ignored flags", () => {
  const failure = { ok: false, error: { code: "WORKFLOW_FAILED", message: "Provider failed", retryable: false,
    layer: "provider", runId: "run", stepId: "step", agentId: "agent", provider: "example", location: { line: 3, column: 2 } } };
  assert.deepEqual(decodeWorkflowReply(failure), failure);
  const scope = { workspaceId: "w", workspaceRoot: "/project" };
  assert.throws(() => decodeWorkflowRequest({ operation: "run", scope, input: {} }), /Provide/);
  assert.throws(() => decodeWorkflowRequest({ operation: "control", scope,
    input: { runId: "r", action: "stop", stepId: "s" } }), /stepId/);
  assert.throws(() => parseWorkflowCli(["show", "r", "--budget", "2"]), /not valid/);
  assert.throws(() => parseWorkflowCli(["run", "a.js", "extra"]), /Unexpected/);
  const parsed = parseWorkflowCli(["wait", "r", "--timeout", "2", "--after-revision", "3", "--json"]);
  assert.deepEqual(parsed, { operation: "wait", input: { runId: "r", timeoutMs: 2000, afterRevision: 3 }, json: true });
  assert.throws(() => decodeWorkflowRequest({ operation: "wait", scope, input: { runId: "r", timeoutMs: NaN } }));
});
