import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
import { workflowsEnabled } from "./workflow-flag.js";

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

type ManagedSkillName = typeof SUBAGENTS_SKILL_NAME | typeof WORKFLOWS_SKILL_NAME;

// The workflows skill is part of the hidden DEVSPACE_EXPERIMENTAL_WORKFLOWS feature.
function managedSkillNames(): ManagedSkillName[] {
  return workflowsEnabled() ? [SUBAGENTS_SKILL_NAME, WORKFLOWS_SKILL_NAME] : [SUBAGENTS_SKILL_NAME];
}

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

// Sync every bundled file, not just SKILL.md, so references a skill points to (such as reference.md) ship with it.
function syncManagedSkill(config: ServerConfig, name: ManagedSkillName): void {
  const sourceDir = join(bundledSkillsDir(), name);

  for (const file of readdirSync(sourceDir)) {
    syncManagedFile(join(sourceDir, file), join(config.devspaceSkillsDir, name, file), name);
  }
}

function syncManagedFile(sourcePath: string, targetPath: string, name: ManagedSkillName): void {
  const source = readFileSync(sourcePath, "utf8");

  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);

    if (stat.isFile() && source === readFileSync(targetPath, "utf8")) {
      return;
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

  return [...defaultPaths, ...config.skillPaths].flatMap((path) => {
    const resolved = resolveSkillPath(path, cwd);

    if (seen.has(resolved)) return [];
    seen.add(resolved);

    return [resolved];
  });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const managedNames = managedSkillNames();

  if (config.subagents.enabled) {
    for (const name of managedNames) syncManagedSkill(config, name);
  }

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  const withoutManaged = withoutManagedSkills(config, result, managedNames);

  if (!config.subagents.enabled) return withoutManaged;

  const managed = managedNames.map((name) => {
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

function withoutManagedSkills(
  config: ServerConfig,
  result: LoadSkillsResult,
  managedNames: readonly ManagedSkillName[],
): LoadedSkills {
  // A managed workflows copy left behind while the feature was on must not be advertised once it is off.
  const staleWorkflows = join(config.devspaceSkillsDir, WORKFLOWS_SKILL_NAME);

  return {
    skills: result.skills.filter((skill) => (
      // SAFETY: The surrounding checks or construction already match this type.
      !managedNames.includes(skill.name as ManagedSkillName)
      && !(skill.name === WORKFLOWS_SKILL_NAME && isPathInsideRoot(skill.filePath, staleWorkflows))
    )),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;

      // SAFETY: The surrounding checks or construction already match this type.
      return !(collision?.resourceType === "skill" && managedNames.includes(collision.name as ManagedSkillName));
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
