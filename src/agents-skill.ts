import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findGitRoot } from "./cli-workspace.js";

/** The standalone skill is the managed `subagents` skill under a name that cannot clash with an agent's own subagents. */
const STANDALONE_NAME = "devspace-agents";

export const AGENT_SKILL_INSTALL_TARGETS = ["claude-code", "codex", "cursor", "opencode", "agents"] as const;
export type AgentSkillInstallTarget = typeof AGENT_SKILL_INSTALL_TARGETS[number];

interface SkillSource {
  description: string;
  body: string;
}

function bundledSkill(): SkillSource {
  return parseSkillSource(readFileSync(fileURLToPath(new URL("../skills/subagents/SKILL.md", import.meta.url)), "utf8"));
}

/** Accepts CRLF: git's autocrlf checks the file out that way on Windows. */
export function parseSkillSource(source: string): SkillSource {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  const description = match?.[1]?.match(/^description:\s*(.+)$/m)?.[1];
  if (!match || !description) throw new Error("Bundled subagents skill is missing its frontmatter.");
  return { description, body: match[2]! };
}

/** `skill` is a SKILL.md for agents with Agent Skills; `cursor-rule` is a Cursor `.mdc` rule. */
export function renderAgentsSkill(format: "skill" | "cursor-rule" = "skill"): string {
  const { description, body } = bundledSkill();
  const frontmatter = format === "skill"
    ? `name: ${STANDALONE_NAME}\ndescription: ${description}`
    : `description: ${description}\nalwaysApply: false`;
  return `---\n${frontmatter}\n---\n${body}`;
}

export interface AgentSkillInstallOptions {
  project: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Install the standalone skill where `target` discovers it; returns the file written. */
export function installAgentsSkill(
  target: AgentSkillInstallTarget,
  { project, cwd = process.cwd(), env = process.env, home = homedir() }: AgentSkillInstallOptions,
): string {
  const projectRoot = findGitRoot(cwd) ?? cwd;
  const skillFile = (base: string) => join(base, STANDALONE_NAME, "SKILL.md");
  let path: string;
  switch (target) {
    case "claude-code":
      path = skillFile(join(project ? projectRoot : home, ".claude", "skills"));
      break;
    case "agents":
      path = skillFile(join(project ? projectRoot : home, ".agents", "skills"));
      break;
    case "codex":
      // Codex documents only `.agents/skills` for repositories; `~/.codex/skills` is its user directory.
      path = skillFile(project
        ? join(projectRoot, ".agents", "skills")
        : join(env.CODEX_HOME?.trim() || join(home, ".codex"), "skills"));
      break;
    case "opencode":
      path = skillFile(project
        ? join(projectRoot, ".opencode", "skills")
        : join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "opencode", "skills"));
      break;
    case "cursor":
      // Cursor user rules live in its settings UI, not in a file, so rules are project-only.
      if (!project) throw new Error("Cursor rules are per project. Run from the project and add --project.");
      mkdirSync(join(projectRoot, ".cursor", "rules"), { recursive: true });
      path = join(projectRoot, ".cursor", "rules", `${STANDALONE_NAME}.mdc`);
      writeFileSync(path, renderAgentsSkill("cursor-rule"));
      return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderAgentsSkill("skill"));
  return path;
}
