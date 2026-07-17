import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { registerWorkflowTools, type WorkflowToolAuditEvent } from "./mcp.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import { WorkflowStore } from "./store.js";
import { runWorkflowSupervisor } from "./supervisor.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-mcp-test-"));
const originalFakeProvider = process.env.DEVSPACE_WORKFLOW_FAKE_PROVIDER;
process.env.DEVSPACE_WORKFLOW_FAKE_PROVIDER = "1";
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

const completionStore = new WorkflowStore(stateDir);
const supervisor = completionStore.acquireSupervisor({ ownerToken: "mcp-test", ownerPid: 1, leaseMs: 5_000 })!;
const claim = completionStore.claimNextAgentNode({ supervisor, claimToken: "mcp-claim", leaseMs: 5_000 })!;
completionStore.completeAgentNode({
  workflowId: workflow.id,
  nodeKey: "agent",
  attempt: claim.node.attempt,
  claimToken: claim.node.claimToken!,
  status: "succeeded",
  result: { provider: "fake", providerSessionId: "secret-session", finalResponse: "safe final response" },
});
completionStore.releaseSupervisor(supervisor);
completionStore.close();
const audits: WorkflowToolAuditEvent[] = [];
let failSupervisorLaunch = false;
const server = new McpServer({ name: "workflow-test", version: "1.0.0" });
registerWorkflowTools({
  server,
  config,
  workspaces,
  orchestrator,
  launchSupervisor: async () => {
    if (failSupervisorLaunch) throw new Error("startup details must stay private");
    await runWorkflowSupervisor(stateDir, {
      globalConcurrency: 2,
      heartbeatMs: 5,
      nodeLeaseMs: 500,
      supervisorLeaseMs: 500,
      idleMs: 0,
    });
    return { requestedWakeGeneration: 1, spawned: true };
  },
  audit: (event) => audits.push(event),
});
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
  assert.equal(runTool.annotations?.idempotentHint, false);
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

  const dagRun = await client.callTool({
    name: "workflow_run",
    arguments: {
      workspaceId: workspace.id,
      dag: {
        version: 1,
        maxConcurrency: 2,
        nodes: [
          { key: "first", target: "fake", prompt: "first deterministic task" },
          { key: "second", target: "fake", prompt: "second deterministic task" },
        ],
        edges: [{ from: "first", to: "second" }],
      },
      idempotencyKey: "mcp-dag-e2e",
    },
  });
  assert.equal(dagRun.isError, undefined);
  const dagWorkflowId = (dagRun.structuredContent as { workflow: { id: string } }).workflow.id;
  const dagWait = await client.callTool({
    name: "workflow_wait",
    arguments: { workspaceId: workspace.id, workflowId: dagWorkflowId, timeoutMs: 1_000 },
  });
  const dagResult = dagWait.structuredContent as {
    timedOut: boolean;
    workflow: { status: string; finalResponse?: string; nodes: Array<{ status: string; finalResponse?: string }> };
  };
  assert.equal(dagResult.timedOut, false);
  assert.equal(dagResult.workflow.status, "succeeded");
  assert.deepEqual(dagResult.workflow.nodes.map((node) => node.status), ["succeeded", "succeeded"]);
  assert.equal(dagResult.workflow.finalResponse, "fake result");
  const dagEvents = await client.callTool({
    name: "workflow_events",
    arguments: { workspaceId: workspace.id, workflowId: dagWorkflowId, after: 0, limit: 100 },
  });
  assert.equal(dagEvents.isError, undefined);
  assert.ok(((dagEvents.structuredContent as { events: unknown[] }).events).length > 0);

  const result = await client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: workspace.id, workflowId: workflow.id },
  });
  const structured = result.structuredContent as {
    version: number;
    result: string;
    workflow: {
      id: string;
      status: string;
      finalResponse?: string;
      nodes: Array<{ key: string; finalResponse?: string }>;
    };
  };
  assert.equal(structured.version, 1);
  assert.equal(structured.workflow.id, workflow.id);
  assert.equal(structured.workflow.status, "succeeded");
  assert.equal(structured.workflow.finalResponse, "safe final response");
  assert.equal(structured.workflow.nodes[0]!.finalResponse, "safe final response");
  assert.equal((result.content as Array<{ text: string }>)[0]!.text, structured.result);
  const serialized = JSON.stringify(structured);
  assert.doesNotMatch(serialized, /secret prompt|secret profile|workspaceRoot|claimToken|providerSession/);

  const denied = await client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: "unknown", workflowId: workflow.id },
  });
  assert.equal(denied.isError, true);

  const cancellable = orchestrator.submit({
    definition: { version: 1, nodes: [{ key: "agent", type: "agent" }], edges: [] },
    workspace: { workspaceId: workspace.id, workspaceRoot: workspace.root },
  });
  failSupervisorLaunch = true;
  const cancellation = await client.callTool({
    name: "workflow_cancel",
    arguments: { workspaceId: workspace.id, workflowId: cancellable.id },
  });
  assert.equal(cancellation.isError, undefined);
  const cancellationResult = cancellation.structuredContent as {
    supervisor: { started: boolean; errorCode?: string };
    workflow: { id: string; status: string };
  };
  assert.deepEqual(cancellationResult.supervisor, {
    started: false,
    errorCode: "supervisor_start_failed",
  });
  assert.equal(cancellationResult.workflow.id, cancellable.id);
  assert.equal(orchestrator.get(cancellable.id)?.status, "cancelling");
  assert.ok(audits.some((event) => event.tool === "workflow_wait" && event.success));
  assert.ok(audits.some((event) => event.tool === "workflow_events" && event.success));
  assert.ok(audits.some((event) => event.tool === "workflow_status" && event.success));
  assert.ok(audits.some((event) => event.tool === "workflow_status" && !event.success));
  assert.ok(audits.some((event) => event.tool === "workflow_run" && !event.success));
  assert.ok(audits.some((event) => event.tool === "workflow_cancel" && event.success));
  assert.doesNotMatch(JSON.stringify(audits), /secret prompt|secret profile|startup details|secret-session/);
} finally {
  await client.close();
  await server.close();
  orchestrator.close();
  if (originalFakeProvider === undefined) delete process.env.DEVSPACE_WORKFLOW_FAKE_PROVIDER;
  else process.env.DEVSPACE_WORKFLOW_FAKE_PROVIDER = originalFakeProvider;
  rmSync(root, { recursive: true, force: true });
}
