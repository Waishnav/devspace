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

const MANAGED_SKILLS = ["subagents", "workflows"] as const;

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function syncManagedSkill(config: ServerConfig, name: string): string {
  const sourcePath = join(bundledSkillsDir(), name, "SKILL.md");
  const targetPath = join(config.devspaceSkillsDir, name, "SKILL.md");
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

  const enabled = MANAGED_SKILLS.filter((name) => name === "subagents"
    ? config.subagents.enabled : config.workflows?.enabled);
  for (const name of enabled) syncManagedSkill(config, name);
  const result = loadSkills({
    cwd, agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd), includeDefaults: false,
  });
  const managedNames = new Set<string>([
    "subagents",
    ...(config.workflows?.enabled ? ["workflows"] : []),
  ]);
  const managed = enabled.map((name) => {
    const skill = loadSkillsFromDir({ dir: join(config.devspaceSkillsDir, name), source: "devspace" })
      .skills.find((skill) => skill.name === name);
    if (!skill) throw new Error(`Managed ${name} skill could not be loaded.`);
    return skill;
  });
  return {
    skills: [...result.skills.filter((skill) => !managedNames.has(skill.name)), ...managed],
    diagnostics: result.diagnostics.filter(({ collision }) =>
      !(collision?.resourceType === "skill" && managedNames.has(collision.name))),
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
