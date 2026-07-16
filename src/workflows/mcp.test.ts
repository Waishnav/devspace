import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { registerWorkflowTools } from "./mcp.js";
import { WorkflowOrchestrator } from "./orchestrator.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-mcp-test-"));
const stateDir = join(root, "state");
const config = {
  stateDir,
  worktreeRoot: join(root, "worktrees"),
  allowedRoots: [root],
  subagents: true,
  devspaceAgentsDir: join(root, "agents"),
  skillsEnabled: false,
  skillPaths: [],
  devspaceSkillsDir: join(root, "skills"),
  agentDir: join(root, "agent-dir"),
} as unknown as ServerConfig;
const workspaces = new WorkspaceRegistry(config);
const { workspace } = await workspaces.openWorkspace(root);
const orchestrator = new WorkflowOrchestrator(stateDir);
const workflow = orchestrator.submit({
  definition: {
    version: 1,
    nodes: [{
      key: "agent",
      type: "agent",
      config: {
        provider: "fake",
        prompt: "secret prompt",
        profileBody: "secret profile",
        workspaceRoot: root,
        effectivePolicy: { version: 1, mode: "workflow", access: "read_only", environment: {} },
      },
    }],
    edges: [],
  },
  workspace: { workspaceId: workspace.id, workspaceRoot: workspace.root },
});

const server = new McpServer({ name: "workflow-test", version: "1.0.0" });
registerWorkflowTools({ server, config, workspaces, orchestrator });
const client = new Client({ name: "workflow-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["workflow_cancel", "workflow_events", "workflow_run", "workflow_status", "workflow_wait"],
  );
  const runTool = listed.tools.find((tool) => tool.name === "workflow_run")!;
  assert.equal(runTool.annotations?.destructiveHint, true);
  assert.equal(runTool.annotations?.idempotentHint, true);
  const statusTool = listed.tools.find((tool) => tool.name === "workflow_status")!;
  assert.equal(statusTool.annotations?.readOnlyHint, true);

  const ambiguous = await client.callTool({
    name: "workflow_run",
    arguments: {
      workspaceId: workspace.id,
      target: "fake",
      prompt: "single",
      dag: {
        version: 1,
        nodes: [{ key: "dag", target: "fake", prompt: "dag" }],
      },
    },
  });
  assert.equal(ambiguous.isError, true);

  const result = await client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: workspace.id, workflowId: workflow.id },
  });
  const structured = result.structuredContent as {
    version: number;
    result: string;
    workflow: { id: string; status: string; nodes: Array<{ key: string }> };
  };
  assert.equal(structured.version, 1);
  assert.equal(structured.workflow.id, workflow.id);
  assert.equal(structured.workflow.status, "queued");
  assert.equal((result.content as Array<{ text: string }>)[0]!.text, structured.result);
  const serialized = JSON.stringify(structured);
  assert.doesNotMatch(serialized, /secret prompt|secret profile|workspaceRoot|claimToken|providerSession/);

  const denied = await client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: "unknown", workflowId: workflow.id },
  });
  assert.equal(denied.isError, true);
} finally {
  await client.close();
  await server.close();
  orchestrator.close();
  rmSync(root, { recursive: true, force: true });
}
