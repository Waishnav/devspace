import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const batches = [
    loadSkills({
      cwd,
      agentDir: config.agentDir,
      skillPaths: [workspaceLocalSkillPath(cwd)],
      includeDefaults: false,
    }),
    loadSkills({
      cwd,
      agentDir: config.agentDir,
      skillPaths: [workspaceInstalledSkillPath(cwd)],
      includeDefaults: false,
    }),
    loadSkills({
      cwd,
      agentDir: config.agentDir,
      skillPaths: [bundledSkillPath()],
      includeDefaults: false,
    }),
    loadSkills({
      cwd,
      agentDir: config.agentDir,
      skillPaths: [],
      includeDefaults: true,
    }),
    loadSkills({
      cwd,
      agentDir: config.agentDir,
      skillPaths: config.skillPaths,
      includeDefaults: false,
    }),
  ];

  return mergeLoadedSkills(batches);
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}

function bundledSkillPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "core");
}

function workspaceLocalSkillPath(cwd: string): string {
  return resolve(cwd, "skills", "local");
}

function workspaceInstalledSkillPath(cwd: string): string {
  return resolve(cwd, "skills", "installed");
}

function mergeLoadedSkills(batches: LoadedSkills[]): LoadedSkills {
  const winners = new Map<string, Skill>();
  const diagnostics: LoadSkillsResult["diagnostics"] = [];

  for (const batch of batches) {
    diagnostics.push(...batch.diagnostics);
    for (const skill of batch.skills) {
      const existing = winners.get(skill.name);
      if (!existing) {
        winners.set(skill.name, skill);
        continue;
      }

      diagnostics.push({
        type: "collision",
        message: `name "${skill.name}" collision`,
        path: skill.filePath,
        collision: {
          resourceType: "skill",
          name: skill.name,
          winnerPath: existing.filePath,
          loserPath: skill.filePath,
        },
      });
    }
  }

  return {
    skills: Array.from(winners.values()),
    diagnostics,
  };
}
