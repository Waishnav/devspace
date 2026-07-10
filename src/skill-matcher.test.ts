import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { matchWorkspaceSkills } from "./skill-matcher.js";
import { resolveSkillReadPath } from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "gpt-agent-skill-matcher-test-"));
const workspaceRoot = join(root, "project");
const globalRoot = join(root, "global");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(globalRoot, { recursive: true });
  const projectSkill = await skill(workspaceRoot, "dashboard-audit", [
    "---",
    "name: dashboard-audit",
    "description: Audit dashboard accessibility and responsive layout.",
    "short-description: Check dashboard UI accessibility.",
    "triggers:",
    "  - dashboard audit",
    "  - accessibility review",
    "required-tools:",
    "  - design_audit",
    "  - invalid tool value",
    "---",
    "Body must not be returned.",
  ].join("\n"));
  const otherSkill = await skill(workspaceRoot, "database-migration", [
    "---",
    "name: database-migration",
    "description: Migrate relational database schemas.",
    "---",
    "Database body.",
  ].join("\n"));
  const globalSkill = await skill(globalRoot, "global-dashboard", [
    "---",
    "name: global-dashboard",
    "description: Review global dashboard navigation.",
    "---",
    "Global body.",
  ].join("\n"));
  const disabledSkill = { ...otherSkill, name: "disabled-dashboard", disableModelInvocation: true };
  const skills = [projectSkill, otherSkill, globalSkill, disabledSkill];

  const first = await matchWorkspaceSkills({
    skills,
    workspaceRoot,
    task: "Run a dashboard audit and accessibility review",
    limit: 1,
  });
  assert.deepEqual(first.matches.map((match) => match.name), ["dashboard-audit"]);
  assert.deepEqual(first.matches[0]?.requiredTools, ["design_audit"]);
  assert.equal(first.metrics.cacheHit, false);
  assert.equal(first.metrics.returnedItems, 1);
  assert.equal(first.metrics.payloadCharacters, JSON.stringify(first).length);
  assert.equal(JSON.stringify(first).includes("Body must not be returned"), false);
  assert.equal(
    resolveSkillReadPath(skills, new Set(), first.matches[0]!.path)?.absolutePath,
    projectSkill.filePath,
  );

  const second = await matchWorkspaceSkills({
    skills,
    workspaceRoot,
    task: "Review the dashboard navigation",
    includeGlobal: true,
    limit: 1,
  });
  assert.equal(second.metrics.cacheHit, true);
  assert.equal(second.metrics.truncated, true);
  assert.equal(second.matches.length, 1);

  const none = await matchWorkspaceSkills({
    skills,
    workspaceRoot,
    task: "compile a Rust kernel module",
  });
  assert.deepEqual(none.matches, []);
  assert.equal(none.metrics.returnedItems, 0);

  const designBase = join(process.cwd(), "skills", "design-system-audit");
  const designSkill = {
    name: "design-system-audit",
    description: "Audit rendered interface design systems.",
    baseDir: designBase,
    filePath: join(designBase, "SKILL.md"),
    disableModelInvocation: false,
  } as Skill;
  const designMatch = await matchWorkspaceSkills({
    skills: [designSkill],
    workspaceRoot,
    task: "Run a design system audit",
    includeGlobal: true,
  });
  assert.deepEqual(designMatch.matches[0]?.requiredTools, [
    "design_audit",
    "focused_context",
    "read",
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function skill(base: string, name: string, content: string): Promise<Skill> {
  const baseDir = join(base, ".agents", "skills", name);
  const filePath = join(baseDir, "SKILL.md");
  await mkdir(baseDir, { recursive: true });
  await writeFile(filePath, content);
  return {
    name,
    description: content.match(/description:\s*([^\n]+)/)?.[1] ?? name,
    filePath,
    baseDir,
    disableModelInvocation: false,
  } as Skill;
}
