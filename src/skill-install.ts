import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devspaceSkillsDir } from "./user-config.js";

const BUNDLED_AGENT_SKILLS = ["subagents", "dynamic-workflows"] as const;
const MANAGED_MARKER = ".devspace-managed";

export interface AgentSkillInstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  directory: string;
}

export function installBundledAgentSkills(
  env: NodeJS.ProcessEnv = process.env,
): AgentSkillInstallResult {
  const sourceRoot = fileURLToPath(new URL("../skills", import.meta.url));
  const directory = devspaceSkillsDir(env);
  mkdirSync(directory, { recursive: true });
  const result: AgentSkillInstallResult = {
    installed: [],
    updated: [],
    skipped: [],
    directory,
  };

  for (const name of BUNDLED_AGENT_SKILLS) {
    const source = join(sourceRoot, name);
    const destination = join(directory, name);
    const marker = join(destination, MANAGED_MARKER);
    if (existsSync(destination) && !existsSync(marker)) {
      result.skipped.push(name);
      continue;
    }

    const staging = mkdtempSync(join(directory, `.install-${name}-`));
    try {
      cpSync(source, staging, { recursive: true });
      writeFileSync(
        join(staging, MANAGED_MARKER),
        "Managed by `devspace init`; place custom overrides in ~/.agents/skills or a project skill directory.\n",
      );
      if (!existsSync(destination)) {
        renameSync(staging, destination);
        result.installed.push(name);
        continue;
      }

      const backup = join(directory, `.backup-${name}-${randomUUID()}`);
      renameSync(destination, backup);
      try {
        renameSync(staging, destination);
        rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        if (!existsSync(destination)) renameSync(backup, destination);
        throw error;
      }
      result.updated.push(name);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  return result;
}
