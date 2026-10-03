import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerConfig } from "./config.js";
import { registerLocalAgentMcpTools } from "./local-agent-mcp-tools.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

export interface LocalAgentMcpScope {
  parentAgentId: string;
  workspaceId: string;
  workspaceRoot: string;
  maxWriteMode: LocalAgentWriteMode;
}

export function createLocalAgentMcpServer(
  config: ServerConfig,
  scope: LocalAgentMcpScope,
): McpServer {
  const server = new McpServer(
    { name: "devspace-agents", title: "DevSpace Agents", version: "1" },
    {
      instructions: [
        `You are delegating from parent agent ${scope.parentAgentId}.`,
        `This control plane is scoped to workspace ${scope.workspaceId}.`,
        `Pass workspace_id=${scope.workspaceId} to every agent tool.`,
        `You may delegate at most ${scope.maxWriteMode} authority; child write_mode cannot exceed it.`,
        "Use agent_targets before choosing a target. Prefer agent_wait over polling agent_status.",
        "Use agent_send only for related follow-up that benefits from the same child context.",
      ].join(" "),
    },
  );
  registerLocalAgentMcpTools(server, {
    config,
    maxWriteMode: scope.maxWriteMode,
    resolveScope: async (workspaceId) => {
      if (workspaceId !== scope.workspaceId) {
        throw new Error(`This agent control plane is scoped to workspace ${scope.workspaceId}.`);
      }
      return { workspaceId: scope.workspaceId, workspaceRoot: scope.workspaceRoot };
    },
  });
  return server;
}

export async function runLocalAgentMcpStdio(
  config: ServerConfig,
  scope: LocalAgentMcpScope,
): Promise<void> {
  const server = createLocalAgentMcpServer(config, scope);
  await server.connect(new StdioServerTransport());
}
