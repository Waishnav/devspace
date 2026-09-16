import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  loadSkillsFromDir,
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
}

const SUBAGENTS_SKILL_NAME = "subagents";
const WORKFLOWS_SKILL_NAME = "workflows";
const MANAGED_SKILL_NAMES = [SUBAGENTS_SKILL_NAME, WORKFLOWS_SKILL_NAME] as const;

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function syncManagedSkill(config: ServerConfig, name: typeof MANAGED_SKILL_NAMES[number]): string {
  const skillPath = join(name, "SKILL.md");
  const sourcePath = join(bundledSkillsDir(), skillPath);
  const targetPath = join(config.devspaceSkillsDir, skillPath);
  const source = readFileSync(sourcePath, "utf8");

  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);
    if (stat.isFile() && source === readFileSync(targetPath, "utf8")) {
      return targetPath;
    }
    if (stat.isDirectory()) {
      throw new Error(`Managed ${name} skill path is a directory: ${targetPath}`);
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, source, { mode: 0o644 });
    rmSync(targetPath, { force: true });
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }

  return targetPath;
}

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    config.devspaceSkillsDir,
    join(config.agentDir, "skills"),
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  if (config.subagents.enabled) {
    for (const name of MANAGED_SKILL_NAMES) syncManagedSkill(config, name);
  }

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  const withoutManaged = withoutManagedSkills(result);
  if (!config.subagents.enabled) return withoutManaged;

  const managed = MANAGED_SKILL_NAMES.map((name) => {
    const managedDir = dirname(join(config.devspaceSkillsDir, name, "SKILL.md"));
    const skill = loadSkillsFromDir({ dir: managedDir, source: "devspace" })
      .skills.find((entry) => entry.name === name);
    if (!skill) throw new Error(`Managed ${name} skill could not be loaded.`);
    return skill;
  });

  return {
    skills: [...withoutManaged.skills, ...managed],
    diagnostics: withoutManaged.diagnostics,
  };
}

function withoutManagedSkills(result: LoadSkillsResult): LoadedSkills {
  return {
    skills: result.skills.filter((skill) => !MANAGED_SKILL_NAMES.includes(skill.name as typeof MANAGED_SKILL_NAMES[number])),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;
      return !(collision?.resourceType === "skill" && MANAGED_SKILL_NAMES.includes(collision.name as typeof MANAGED_SKILL_NAMES[number]));
    }),
  };
}

export function resolveSkillReadPath(
  skills: Skill[],
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill };
  }

  return undefined;
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
