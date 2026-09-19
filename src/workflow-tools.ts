import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { decodeWorkflowRequest, workflowInputs, type WorkflowOperation, type WorkflowReply, type WorkflowRequest } from "./workflow-protocol.js";

const publicKey = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const descriptions: Record<WorkflowOperation, string> = {
  run: "Run a JavaScript workflow that coordinates configured subagents in this workspace. Supply script, script_path, or a saved name. Returns a run ID immediately; use wait_workflow for the result. Read the workflows skill for script primitives. Use resume_from_run_id to replay a stopped prior run.",
  get: "Inspect a workflow's status and result, or one step's details. Reuse the workspace and run ID returned at launch.",
  wait: "Wait for workflow progress, completion, or required attention. Pass the last revision to wait for a change. A timeout or disconnected wait does not cancel the workflow.",
  control: "Pause, resume, or stop a workflow. Supply step_id only to stop or restart an individual agent; restart is allowed before its result has been delivered.",
  list: "List saved workflow definitions or previous runs in this workspace.",
  save: "Save a workflow's script as a reusable project or personal definition. Existing names require explicit replace=true.",
};

export function registerWorkflowTools(options: {
  server: Pick<McpServer, "registerTool">;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  request?: (request: WorkflowRequest) => Promise<WorkflowReply>;
}): void {
  if (!options.config.workflows?.enabled) return;
  const request = options.request ?? ((input) => createLocalAgentClient(options.config).workflow(input));
  for (const operation of Object.keys(workflowInputs) as WorkflowOperation[]) {
    const schema = z.object({
      workspace_id: z.string().min(1).describe("Reuse the current workspace_id."),
      ...Object.fromEntries(Object.entries(workflowInputs[operation].shape).map(([key, schema]) => [publicKey(key), schema])),
    }).strict();
    options.server.registerTool(`${operation}_workflow${operation === "list" ? "s" : ""}`, {
      description: descriptions[operation],
      inputSchema: schema,
      annotations: {
        readOnlyHint: operation === "get" || operation === "wait" || operation === "list",
        destructiveHint: operation === "run" || operation === "control",
        openWorldHint: operation === "run",
      },
    }, async (value) => {
      try {
        const { workspace_id: workspaceId, ...publicInput } = value;
        const input = Object.fromEntries(Object.keys(workflowInputs[operation].shape)
          .filter((key) => Object.hasOwn(publicInput, publicKey(key)))
          .map((key) => [key, (publicInput as Record<string, unknown>)[publicKey(key)]]));
        const workspace = await options.workspaces.getWorkspace(workspaceId);
        const reply = await request(decodeWorkflowRequest({
          operation, scope: { workspaceId, workspaceRoot: workspace.root }, input,
        }));
        return {
          ...(reply.ok ? {} : { isError: true }),
          content: [{ type: "text" as const, text: JSON.stringify(reply.ok ? reply.result : reply.error) }],
          structuredContent: reply.ok ? { result: reply.result } : { error: reply.error },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Invalid workflow request." }] };
      }
    });
  }
}
