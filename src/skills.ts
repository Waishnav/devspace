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

const SKILL_URI_PREFIX = "skills://";
const MAX_SKILL_NAME_LENGTH = 64;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUBAGENTS_SKILL_NAME = "subagents";
const SUBAGENTS_SKILL = join(SUBAGENTS_SKILL_NAME, "SKILL.md");

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function bundledSubagentsSkillPath(): string {
  return join(bundledSkillsDir(), SUBAGENTS_SKILL);
}

function syncManagedSubagentsSkill(config: ServerConfig): string {
  const sourcePath = bundledSubagentsSkillPath();
  const targetPath = join(config.devspaceSkillsDir, SUBAGENTS_SKILL);
  const source = readFileSync(sourcePath, "utf8");

  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);
    if (stat.isFile() && source === readFileSync(targetPath, "utf8")) {
      return targetPath;
    }
    if (stat.isDirectory()) {
      throw new Error(`Managed subagents skill path is a directory: ${targetPath}`);
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
    syncManagedSubagentsSkill(config);
  }

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  const withoutSubagents = withoutSubagentsSkill(result);
  const available = config.experimentalSkillUris
    ? {
        skills: withoutSubagents.skills.filter((skill) => isRoutableSkillName(skill.name)),
        diagnostics: withoutSubagents.diagnostics,
      }
    : withoutSubagents;
  if (!config.subagents.enabled) return available;

  const managedDir = dirname(join(config.devspaceSkillsDir, SUBAGENTS_SKILL));
  const managed = loadSkillsFromDir({
    dir: managedDir,
    source: "devspace",
  }).skills.find((skill) => skill.name === SUBAGENTS_SKILL_NAME);
  if (!managed) {
    throw new Error("Managed subagents skill could not be loaded.");
  }

  return {
    skills: [...available.skills, managed],
    diagnostics: available.diagnostics,
  };
}

function withoutSubagentsSkill(result: LoadSkillsResult): LoadedSkills {
  return {
    skills: result.skills.filter((skill) => skill.name !== SUBAGENTS_SKILL_NAME),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;
      return !(collision?.resourceType === "skill" && collision.name === SUBAGENTS_SKILL_NAME);
    }),
  };
}

export function resolveSkillReadPath(
  skills: Skill[],
  inputPath: string,
  experimentalSkillUris: boolean,
): SkillReadResolution | undefined {
  if (!experimentalSkillUris) {
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

  if (!inputPath.startsWith(SKILL_URI_PREFIX)) return undefined;

  const skillReference = inputPath.slice(SKILL_URI_PREFIX.length);
  const separatorIndex = skillReference.indexOf("/");
  const skillName = separatorIndex === -1
    ? skillReference
    : skillReference.slice(0, separatorIndex);
  const resourcePath = separatorIndex === -1
    ? undefined
    : skillReference.slice(separatorIndex + 1);

  if (!skillName) {
    throw new Error(`Invalid skill URI: ${inputPath}`);
  }
  if (!isRoutableSkillName(skillName)) {
    throw new Error(`Invalid skill URI: ${inputPath}`);
  }

  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    throw new Error(`Unknown skill: ${skillName}`);
  }

  if (!resourcePath) {
    return { absolutePath: resolve(skill.filePath), skill };
  }

  const baseDir = resolve(skill.baseDir);
  const absolutePath = resolve(baseDir, resourcePath);
  if (!isPathInsideRoot(absolutePath, baseDir)) {
    throw new Error(`Skill resource is outside skill directory: ${inputPath}`);
  }

  return { absolutePath, skill };
}

export function formatSkillUri(skill: Skill): string {
  if (!isRoutableSkillName(skill.name)) {
    throw new Error(`Invalid skill name for skills:// URI: ${skill.name}`);
  }
  return `${SKILL_URI_PREFIX}${skill.name}`;
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

function isRoutableSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
}
