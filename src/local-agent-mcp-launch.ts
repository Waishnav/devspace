import { fileURLToPath } from "node:url";
import type { LocalAgentRunInput, LocalAgentRuntimeContext, LocalAgentWriteMode } from "./local-agent-runtime.js";

export interface LocalAgentMcpLaunch {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function localAgentMcpLaunch(
  input: Pick<LocalAgentRunInput, "agentId" | "workspaceId" | "workspaceRoot" | "writeMode" | "mcpCapability">,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentMcpLaunch | undefined {
  if (!input.workspaceId || !input.agentId || !input.mcpCapability) return undefined;
  const configDir = env.DEVSPACE_CONFIG_DIR?.trim();
  return {
    name: `devspace-agents-${input.agentId}`,
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/devspace.js", import.meta.url)), "agents", "mcp"],
    env: {
      ...(configDir ? { DEVSPACE_CONFIG_DIR: configDir } : {}),
      DEVSPACE_AGENT_MCP_CAPABILITY: input.mcpCapability,
    },
  };
}

export function localAgentMcpLaunchFromContext(
  context: Pick<LocalAgentRuntimeContext, "agentId" | "workspaceId" | "workspaceRoot" | "writeMode" | "mcpCapability">,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentMcpLaunch | undefined {
  return localAgentMcpLaunch(context, env);
}

export function writeModeAtMost(
  requested: LocalAgentWriteMode,
  maximum: LocalAgentWriteMode,
): boolean {
  return writeModeRank(requested) <= writeModeRank(maximum);
}

function writeModeRank(mode: LocalAgentWriteMode): number {
  switch (mode) {
    case "read_only": return 0;
    case "allowed": return 1;
    case "full_access": return 2;
  }
}
