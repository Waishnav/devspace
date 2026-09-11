import type { ToolMode } from "../config.js";
import { codexInstructions, registerCodexTools } from "./codex.js";
import { claudeInstructions, registerClaudeTools } from "./claude.js";
import { toolNames, type ToolSurface } from "./types.js";

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  claude: {
    shellToolName: toolNames.shell,
    register: registerClaudeTools,
    instructions: claudeInstructions,
  },
  codex: {
    shellToolName: toolNames.exec,
    register: registerCodexTools,
    instructions: codexInstructions,
  },
};

export function getToolSurface(mode: ToolMode): ToolSurface {
  return TOOL_SURFACES[mode];
}
