import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  effectiveSkillPaths,
  formatPathForPrompt,
  loadWorkspaceSkills,
  resolveSkillReadPath,
} from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

try {
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  const devspaceSkills = join(root, ".devspace", "skills");
  const globalAgentsSkills = join(root, ".agents", "skills");
  const projectAgentsSkills = join(projectRoot, ".agents", "skills");
  const globalClaudeSkills = join(root, ".claude", "skills");
  const projectClaudeSkills = join(projectRoot, ".claude", "skills");
  await mkdir(join(globalAgentsSkills, "agent-global-skill"), { recursive: true });
  await mkdir(join(projectAgentsSkills, "agent-project-skill"), { recursive: true });
  await mkdir(join(globalClaudeSkills, "claude-global-skill"), { recursive: true });
  await mkdir(join(projectClaudeSkills, "claude-project-skill"), { recursive: true });
  await mkdir(join(projectRoot, ".pi", "skills", "project-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "subagent-delegation"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });
  await mkdir(join(explicitSkills, "subagent-delegation"), { recursive: true });
  await mkdir(join(devspaceSkills, "devspace-local-skill"), { recursive: true });

  await writeFile(
    join(globalAgentsSkills, "agent-global-skill", "SKILL.md"),
    [
      "---",
      "name: agent-global-skill",
      "description: Agent global skill description.",
      "---",
      "",
      "# Agent Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectAgentsSkills, "agent-project-skill", "SKILL.md"),
    [
      "---",
      "name: agent-project-skill",
      "description: Agent project skill description.",
      "---",
      "",
      "# Agent Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(globalClaudeSkills, "claude-global-skill", "SKILL.md"),
    [
      "---",
      "name: claude-global-skill",
      "description: Claude global skill description.",
      "---",
      "",
      "# Claude Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectClaudeSkills, "claude-project-skill", "SKILL.md"),
    [
      "---",
      "name: claude-project-skill",
      "description: Claude project skill description.",
      "---",
      "",
      "# Claude Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectRoot, ".pi", "skills", "project-skill", "SKILL.md"),
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
    join(devspaceSkills, "devspace-local-skill", "SKILL.md"),
    [
      "---",
      "name: devspace-local-skill",
      "description: DevSpace local skill description.",
      "---",
      "",
      "# DevSpace Local Skill",
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
  await writeFile(
    join(agentDir, "skills", "subagent-delegation", "SKILL.md"),
    [
      "---",
      "name: subagent-delegation",
      "description: Hidden subagent skill winner.",
      "---",
      "",
      "# Subagent Delegation",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "subagent-delegation", "SKILL.md"),
    [
      "---",
      "name: subagent-delegation",
      "description: Hidden subagent skill loser.",
      "---",
      "",
      "# Subagent Delegation Duplicate",
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
    DEVSPACE_SKILL_PATHS: [explicitSkills, "~/.claude/skills", "./.claude/skills"].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "project-skill"), false);
  assert.equal(loaded.skills.some((skill) => skill.name === "devspace-local-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "subagent-delegation"), false);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(loaded.skills.some((skill) => skill.name === "hidden-skill"), true);
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);
  assert.equal(
    loaded.diagnostics.some(
      (diagnostic) => diagnostic.collision?.name === "subagent-delegation",
    ),
    false,
  );

  const experimentalConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    loadWorkspaceSkills(experimentalConfig, projectRoot).skills.some(
      (skill) => skill.name === "subagent-delegation",
    ),
    true,
  );

  const duplicateConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: [explicitSkills, "./.agents/skills"].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    effectiveSkillPaths(duplicateConfig, projectRoot).filter((path) => path === projectAgentsSkills).length,
    1,
  );

  const legacyPiConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: [explicitSkills, join(projectRoot, ".pi", "skills")].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    loadWorkspaceSkills(legacyPiConfig, projectRoot).skills.some((skill) => skill.name === "project-skill"),
    true,
  );

  const projectSkill = loaded.skills.find((skill) => skill.name === "agent-project-skill");
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
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
}
