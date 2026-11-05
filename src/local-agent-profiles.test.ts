import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

test("project profiles override global profiles and disabled profiles are skipped", async (t) => {
  const { workspaceRoot, enabledConfig } = await fixture(t);
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "reviewer");
  assert.equal(profiles[0]?.description, "Project reviewer #1.");
  assert.equal(profiles[0]?.provider, "claude");
  assert.equal(profiles[0]?.model, "sonnet");
  assert.equal(profiles[0]?.effort, "high");
  assert.equal(profiles[0]?.body, "Project body.");
});

test("profiles may target a named provider instance", async (t) => {
  const { workspaceRoot, enabledConfig } = await fixture(t);
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Named provider instance.",
      "provider: codex-work",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithNamedInstance = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithNamedInstance.map((profile) => profile.name), ["custom", "reviewer"]);
  assert.equal(profilesWithNamedInstance[0]?.provider, "codex-work");
});

test("no profiles load while subagents are disabled", async (t) => {
  const { configDir, workspaceRoot } = await fixture(t);

  const disabledConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [workspaceRoot] },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));

  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Global reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "Project reviewer #1."',
      "provider: claude",
      "model: sonnet",
      "effort: high",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "disabled.md"),
    [
      "---",
      "name: disabled",
      "description: Disabled agent.",
      "provider: codex",
      "disabled: true",
      "---",
      "",
      "Disabled body.",
      "",
    ].join("\n"),
  );

  const enabledConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [workspaceRoot] },
    subagents: { enabled: true, instructions: "on-demand", providers: [] },
  }));

  return { configDir, workspaceRoot, enabledConfig };
}
