import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installAgentsSkill, parseSkillSource, renderAgentsSkill } from "./agents-skill.js";

test("the managed skill renders as a skill and as a Cursor rule sharing the standalone body", () => {
  const skill = renderAgentsSkill();
  assert.match(skill, /^---\nname: devspace-agents\ndescription: Delegate focused coding/);
  assert.match(skill, /devspace agents targets/);
  assert.equal(
    readFileSync(new URL("../skills/subagents/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n---\n")[1],
    skill.split("\n---\n")[1],
    "the standalone skill must share the managed skill body",
  );
  assert.match(renderAgentsSkill("cursor-rule"), /^---\ndescription: Delegate focused coding[^\n]*\nalwaysApply: false\n---\n\n# DevSpace subagents/);
});

test("skill sources with CRLF frontmatter parse into description and body", () => {
  assert.deepEqual(parseSkillSource("---\r\nname: x\r\ndescription: Do things\r\n---\r\n\r\n# Body\r\n"), {
    description: "Do things",
    body: "\n# Body\n",
  });
});

test("the skill installs to each target's global and project locations", (t) => {
  const skill = renderAgentsSkill();
  const root = mkdtempSync(join(tmpdir(), "devspace-skill-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const env = {};
  const global = (target: Parameters<typeof installAgentsSkill>[0]) =>
    installAgentsSkill(target, { project: false, home, env, cwd: project });
  const local = (target: Parameters<typeof installAgentsSkill>[0]) =>
    installAgentsSkill(target, { project: true, home, env, cwd: project });

  assert.equal(global("claude-code"), join(home, ".claude/skills/devspace-agents/SKILL.md"));
  assert.equal(global("agents"), join(home, ".agents/skills/devspace-agents/SKILL.md"));
  assert.equal(global("codex"), join(home, ".codex/skills/devspace-agents/SKILL.md"));
  assert.equal(global("opencode"), join(home, ".config/opencode/skills/devspace-agents/SKILL.md"));
  assert.equal(readFileSync(global("claude-code"), "utf8"), skill);

  assert.equal(local("claude-code"), join(project, ".claude/skills/devspace-agents/SKILL.md"));
  assert.equal(local("codex"), join(project, ".agents/skills/devspace-agents/SKILL.md"));
  assert.equal(local("opencode"), join(project, ".opencode/skills/devspace-agents/SKILL.md"));
  assert.equal(local("cursor"), join(project, ".cursor/rules/devspace-agents.mdc"));
  assert.equal(readFileSync(local("cursor"), "utf8"), renderAgentsSkill("cursor-rule"));
  assert.throws(() => global("cursor"), /add --project/);

  assert.equal(
    installAgentsSkill("codex", { project: false, home, cwd: project, env: { CODEX_HOME: join(root, "codex") } }),
    join(root, "codex/skills/devspace-agents/SKILL.md"),
  );
});
