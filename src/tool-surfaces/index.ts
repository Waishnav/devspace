import type { ToolMode } from "../config.js";
import { registerWorkspaceLifecycleTool } from "../workspace-lifecycle.js";
import { codexInstructions, registerCodexTools } from "./codex.js";
import { claudeInstructions, registerClaudeTools } from "./claude.js";
import { type ToolRegistrationContext, type ToolSurface } from "./types.js";

function registerWithWorkspaceLifecycle(
  register: (context: ToolRegistrationContext) => void,
): (context: ToolRegistrationContext) => void {
  return (context) => {
    register(context);
    registerWorkspaceLifecycleTool(
      context.server,
      context.config,
      context.workspaces,
      context.processSessions,
    );
  };
}

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  claude: {
    register: registerWithWorkspaceLifecycle(registerClaudeTools),
    instructions: claudeInstructions,
  },
  codex: {
    register: registerWithWorkspaceLifecycle(registerCodexTools),
    instructions: codexInstructions,
  },
};

export function getToolSurface(mode: ToolMode): ToolSurface {
  return TOOL_SURFACES[mode];
}
