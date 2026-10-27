import { codexInstructions, registerCodexTools } from "./codex.js";
import { claudeInstructions, registerClaudeTools } from "./claude.js";
import { type ToolSurface, type ToolSurfaceName } from "./types.js";

export type { ToolSurfaceName } from "./types.js";

export { DEFAULT_TOOL_SURFACE, detectToolSurface, type HostHints } from "./detect.js";

const TOOL_SURFACES: Record<ToolSurfaceName, ToolSurface> = {
  claude: {
    register: registerClaudeTools,
    instructions: claudeInstructions,
  },
  codex: {
    register: registerCodexTools,
    instructions: codexInstructions,
  },
};

export function getToolSurface(name: ToolSurfaceName): ToolSurface {
  return TOOL_SURFACES[name];
}
