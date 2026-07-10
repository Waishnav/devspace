import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  assertLocalAgentProfileBoundary,
  loadLocalAgentProfiles,
  summarizeLocalAgentProfile,
} from "./local-agent-profiles.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));

try {
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
      "thinking: high",
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

  const enabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "reviewer");
  assert.equal(profiles[0]?.description, "Project reviewer #1.");
  assert.equal(profiles[0]?.provider, "claude");
  assert.equal(profiles[0]?.model, "sonnet");
  assert.equal(profiles[0]?.thinking, "high");
  assert.equal(profiles[0]?.writeMode, "allowed");
  assert.equal(profiles[0]?.body, "Project body.");
  assert.deepEqual(summarizeLocalAgentProfile(profiles[0]!), {
    name: "reviewer",
    description: "Project reviewer #1.",
    provider: "claude",
    model: "sonnet",
    thinking: "high",
    writeMode: "allowed",
  });

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "readonly.md"),
    [
      "---",
      "name: readonly",
      "description: Read-only reviewer.",
      "provider: codex",
      "write-mode: read_only",
      "---",
      "",
      "Review only.",
    ].join("\n"),
  );
  const withReadOnly = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.equal(withReadOnly.find((profile) => profile.name === "readonly")?.writeMode, "read_only");
  assert.doesNotThrow(() => assertLocalAgentProfileBoundary(
    withReadOnly.find((profile) => profile.name === "readonly")!,
  ));
  assert.throws(
    () => assertLocalAgentProfileBoundary({
      ...withReadOnly.find((profile) => profile.name === "readonly")!,
      provider: "claude",
    }),
    /requires the codex provider/,
  );
  assert.throws(
    () => assertLocalAgentProfileBoundary({
      ...withReadOnly.find((profile) => profile.name === "readonly")!,
      name: "codex",
    }),
    /reserved for the raw provider target/,
  );

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "invalid-mode.md"),
    [
      "---",
      "name: invalid-mode",
      "description: Invalid mode.",
      "provider: codex",
      "write-mode: full_access",
      "---",
    ].join("\n"),
  );

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Unsupported custom agent.",
      "provider: custom",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithInvalid.map((profile) => profile.name), ["readonly", "reviewer"]);

  const builtinConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_BUILTIN_PROFILES: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const builtinProfiles = await loadLocalAgentProfiles(builtinConfig, workspaceRoot);
  for (const name of ["design", "explore", "implement", "review"]) {
    assert.ok(builtinProfiles.some((profile) => profile.name === name));
  }
  assert.equal(builtinProfiles.find((profile) => profile.name === "explore")?.writeMode, "read_only");
  assert.equal(builtinProfiles.find((profile) => profile.name === "implement")?.writeMode, "allowed");

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
} finally {
  await rm(root, { recursive: true, force: true });
}
