import type { ToolNames } from "./server.js";

export type CollaborationMode = "default" | "plan";

export interface PromptingContext {
  minimalTools: boolean;
  skillsEnabled: boolean;
  widgetsChangesOnly: boolean;
}

export function serverInstructions(
  context: PromptingContext,
  toolNames: ToolNames,
): string {
  const inspection = context.minimalTools
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = context.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  const showChanges = context.widgetsChangesOnly
    ? " After creating, editing, or overwriting files, call show_changes once after the related file changes are complete so the user can see the aggregate diff."
    : "";

  const planning =
    " Use get_collaboration_mode to inspect the workspace collaboration mode. Use set_collaboration_mode to switch between default execution and plan mode. In default mode, use update_plan for a concise execution checklist when helpful. In plan mode, prefer request_user_input, repository exploration, and concrete specification work; do not use update_plan while plan mode is active. When the user asks to pursue a concrete objective across multiple turns, use create_goal to start one goal for that workspace, get_goal to inspect its status, and update_goal to mark it complete or blocked.";

  const style =
    " Prefer action over explanation. Keep responses terse and operational. For mode switches, goal updates, confirmations, cancellations, pending answers, and other straightforward workflow steps, return only the necessary status or next action. Do not add long design discussion, repeated background, or speculative future improvements unless the user explicitly asks for them. When the user sends a short reply such as '1B, 2A', treat it as workflow input and continue instead of explaining the mechanism back to them.";

  const commands =
    " When available skills include a matching workflow skill, read that skill before handling slash-style workspace commands or compact user-input replies. For concise workflow commands and compact pending-input replies, prefer handle_workspace_command or answer_user_input(text) over paraphrasing the user's message.";

  return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, shell, plan, and goal tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}${planning}${style}${commands} Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, apply_workspace_patch for coordinated multi-file patches, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Use git_push for explicit push requests instead of raw git push through ${toolNames.shell}. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChanges}`;
}

export function workspaceInstruction(
  mode: CollaborationMode,
  skillsEnabled: boolean,
): string {
  const base = skillsEnabled
    ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
    : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";

  if (mode === "plan") {
    return `${base} This workspace is currently in plan mode: explore first, ask clarifying questions with request_user_input only when they materially affect the plan, and produce a concrete implementation plan before execution. Keep the plan decision complete but compact. Do not repeat already-confirmed choices, do not add long design essays, and do not use update_plan while plan mode is active.`;
  }

  return `${base} This workspace is currently in default mode: execute work directly, keep status updates brief, and use update_plan only when a concise execution checklist would help. Do not add unnecessary explanation for straightforward actions or results.`;
}
