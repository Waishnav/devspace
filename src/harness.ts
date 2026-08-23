import * as z from "zod/v4";

export const harnessConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude-code").describe("Expose the Claude Code-style coding harness."),
    inspection: z
      .enum(["shell", "dedicated"])
      .describe("Use shell inspection or expose dedicated grep/glob/ls tools."),
  }),
  z.object({
    kind: z.literal("codex").describe("Expose the Codex-style coding harness."),
  }),
]);

export type HarnessConfig =
  | {
      kind: "claude-code";
      inspection: "shell" | "dedicated";
    }
  | {
      kind: "codex";
    };

export type LegacyToolMode = "minimal" | "full" | "codex";

export type HarnessToolGroup =
  | "write-edit"
  | "dedicated-inspection"
  | "bash"
  | "apply-patch"
  | "process-session";

export interface CompiledHarness {
  toolGroups: readonly HarnessToolGroup[];
  instructions: string;
  bashDescription?: string;
}

export function harnessFromLegacyToolMode(mode: LegacyToolMode): HarnessConfig {
  switch (mode) {
    case "minimal":
      return { kind: "claude-code", inspection: "shell" };
    case "full":
      return { kind: "claude-code", inspection: "dedicated" };
    case "codex":
      return { kind: "codex" };
  }
}

export function compileHarness(
  harness: HarnessConfig,
  options: { skillsEnabled: boolean },
): CompiledHarness {
  if (harness.kind === "codex") {
    return {
      toolGroups: ["apply-patch", "process-session"],
      instructions:
        "Use DevSpace for coding work. Call open_workspace once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call open_workspace again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use read for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by open_workspace; read applicable instruction and skill files before working in their scope.",
    };
  }

  const dedicatedInspection = harness.inspection === "dedicated";
  const inspectionInstruction = dedicatedInspection
    ? "Prefer read, grep, glob, and ls for file inspection. "
    : "In shell inspection mode, grep, glob, and ls are disabled; use bash with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. ";
  const skillsInstruction = options.skillsEnabled
    ? "When open_workspace returns available skills and a task matches a skill, use read to read that skill's path before proceeding. Skill paths may be outside the workspace, but read only permits advertised SKILL.md files and files under already-loaded skill directories. "
    : "";
  const commonInstruction =
    "Use DevSpace for coding work. Call open_workspace once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call open_workspace again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Follow instructions returned by open_workspace. Before working under a path listed in availableAgentsFiles, use read to inspect that instruction file and follow it. ";

  return {
    toolGroups: dedicatedInspection
      ? ["write-edit", "dedicated-inspection", "bash"]
      : ["write-edit", "bash"],
    instructions:
      `${commonInstruction}${skillsInstruction}${inspectionInstruction}Prefer edit for targeted modifications, write only for new files or complete rewrites, and bash for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with bash; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.`,
    bashDescription: dedicatedInspection
      ? "Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use bash to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use edit for targeted changes and write for new files or full rewrites. Prefer read, grep, glob, and ls for file inspection. This is powerful execution and should only be exposed behind strong authentication."
      : "Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In shell inspection mode, grep, glob, and ls are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use bash to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use edit for targeted changes and write for new files or full rewrites. Prefer read for direct file reads. This is powerful execution and should only be exposed behind strong authentication.",
  };
}
