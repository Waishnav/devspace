import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  formatPathForPrompt,
  loadWorkspaceSkills,
  resolveSkillReadPath,
} from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));

try {
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  await mkdir(join(projectRoot, "skills", "local", "project-skill"), { recursive: true });
  await mkdir(join(projectRoot, "skills", "installed", "installed-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });

  await writeFile(
    join(projectRoot, "skills", "local", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectRoot, "skills", "installed", "installed-skill", "SKILL.md"),
    [
      "---",
      "name: installed-skill",
      "description: Installed skill description.",
      "---",
      "",
      "# Installed Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: First duplicate wins.",
      "---",
      "",
      "# Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "duplicate", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: Duplicate loser.",
      "---",
      "",
      "# Duplicate Skill",
    ].join("\n"),
  );
  await mkdir(join(projectRoot, "skills", "local", "duplicate-local"), { recursive: true });
  await mkdir(join(projectRoot, "skills", "installed", "duplicate-installed"), { recursive: true });
  await writeFile(
    join(projectRoot, "skills", "local", "duplicate-local", "SKILL.md"),
    [
      "---",
      "name: duplicate-priority-skill",
      "description: Local wins.",
      "---",
      "",
      "# Duplicate Local",
    ].join("\n"),
  );
  await writeFile(
    join(projectRoot, "skills", "installed", "duplicate-installed", "SKILL.md"),
    [
      "---",
      "name: duplicate-priority-skill",
      "description: Installed loses to local.",
      "---",
      "",
      "# Duplicate Installed",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "disabled", "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Hidden skill.",
      "disable-model-invocation: true",
      "---",
      "",
      "# Hidden Skill",
    ].join("\n"),
  );

  const disabledConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.deepEqual(loadWorkspaceSkills(disabledConfig, projectRoot).skills, []);

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.some((skill) => skill.name === "project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "installed-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "devspace-workflow"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "senior-architect-lite"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "skill-authoring-lite"), true);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-priority-skill").length, 1);
  const duplicatePrioritySkill = loaded.skills.find((skill) => skill.name === "duplicate-priority-skill");
  assert.ok(duplicatePrioritySkill);
  assert.match(duplicatePrioritySkill.filePath, /skills\/local\/duplicate-local\/SKILL\.md$/);
  assert.equal(loaded.skills.some((skill) => skill.name === "hidden-skill"), true);
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);

  const projectSkill = loaded.skills.find((skill) => skill.name === "project-skill");
  assert.ok(projectSkill);
  assert.match(formatPathForPrompt(projectSkill.filePath), /SKILL\.md$/);

  const skillFileRead = resolveSkillReadPath(loaded.skills, new Set(), projectSkill.filePath);
  assert.equal(skillFileRead?.isSkillFile, true);
  assert.equal(skillFileRead?.absolutePath, projectSkill.filePath);

  const resourcePath = join(projectSkill.baseDir, "references.md");
  await writeFile(resourcePath, "reference\n");
  assert.equal(resolveSkillReadPath(loaded.skills, new Set(), resourcePath), undefined);
  assert.equal(
    resolveSkillReadPath(loaded.skills, new Set([projectSkill.baseDir]), resourcePath)
      ?.isSkillFile,
    false,
  );

  const bundledWorkflowSkill = loaded.skills.find((skill) => skill.name === "devspace-workflow");
  assert.ok(bundledWorkflowSkill);
  const bundledReferencePath = join(bundledWorkflowSkill.baseDir, "references", "commands.md");
  assert.equal(resolveSkillReadPath(loaded.skills, new Set(), bundledReferencePath), undefined);
  assert.equal(
    resolveSkillReadPath(loaded.skills, new Set([bundledWorkflowSkill.baseDir]), bundledReferencePath)
      ?.isSkillFile,
    false,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
