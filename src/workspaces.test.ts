import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );

  const planSkill = workspace.skills.find((skill) => skill.name === "plan" && skill.source === "devspace_system");
  assert.ok(planSkill, "expected the bundled plan Skill to be available");

  const planSkillFile = registry.resolveReadPath(workspace, planSkill.locator);
  assert.equal(planSkillFile.absolutePath, planSkill.filePath);
  assert.equal(planSkillFile.skillRead?.isSkillFile, true);
  registry.markReadPathLoaded(workspace, planSkillFile);

  const planReference = registry.resolveReadPath(
    workspace,
    "skill://devspace-system/plan/references/state.md",
  );
  assert.equal(planReference.absolutePath, join(planSkill.baseDir, "references", "state.md"));
  assert.equal(planReference.skillRead?.isSkillFile, false);

  await assert.rejects(
    async () => registry.resolveReadPath(workspace, "skill://devspace-system/unknown/SKILL.md"),
    /Unknown or unauthorized Skill resource/,
  );

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  await mkdir(join(root, "skills", "installed", "refresh-skill"), { recursive: true });
  await writeFile(
    join(root, "skills", "installed", "refresh-skill", "SKILL.md"),
    [
      "---",
      "name: refresh-skill",
      "description: Refresh test skill.",
      "---",
      "",
      "# Refresh Skill",
    ].join("\n"),
  );
  assert.equal(workspace.skills.some((skill) => skill.name === "refresh-skill"), false);
  const refreshedWorkspace = registry.refreshWorkspaceSkills(workspace.id);
  assert.equal(refreshedWorkspace.skills.some((skill) => skill.name === "refresh-skill"), true);

  const defaultOnlyConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: `${root},${gitRoot}`,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "default-worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_SESSION_WORKSPACE: root,
    PORT: "1",
  });
  const defaultOnlyRegistry = new WorkspaceRegistry(defaultOnlyConfig);
  const defaultWorkspace = await defaultOnlyRegistry.openWorkspace({ mode: "checkout" });
  assert.equal(defaultWorkspace.workspace.root, root);
  assert.equal(defaultWorkspace.workspace.mode, "checkout");

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  const savedPlan = firstStore.savePlan({
    workspaceSessionId: persistentWorkspace.workspace.id,
    expectedRevision: 0,
    title: "Workflow state migration",
    summary: "Track work in small steps",
    scopeIn: ["project workflow state"],
    validation: ["npm test"],
    steps: [
      { step: "Inspect repo", status: "completed" },
      { step: "Implement plan tools", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ],
  });
  assert.equal(savedPlan.steps.length, 3);
  const savedMode = firstStore.setCollaborationMode({
    workspaceSessionId: persistentWorkspace.workspace.id,
    mode: "plan",
  });
  assert.equal(savedMode.mode, "plan");
  const savedPrompt = firstStore.createUserInputRequest({
    workspaceSessionId: persistentWorkspace.workspace.id,
    questions: [
      {
        header: "Mode",
        id: "mode_choice",
        question: "Which implementation mode should we use?",
        options: [
          { label: "Strict", description: "Closer to Codex semantics" },
          { label: "Loose", description: "More permissive for compatibility" },
        ],
      },
    ],
    autoResolutionMs: 60000,
  });
  assert.equal(savedPrompt.status, "pending");
  const savedGoal = firstStore.saveGoal({
    workspaceSessionId: persistentWorkspace.workspace.id,
    objective: "Ship project-scoped workflow support",
    successCriteria: ["A new session resumes the current Plan and Goal"],
    verification: ["npm test"],
    currentSummary: "Current: migrate workflow state.",
  });
  assert.equal(savedGoal.status, "active");
  const sameProjectSession = await persistentRegistry.openWorkspace(root);
  assert.notEqual(sameProjectSession.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(
    firstStore.getPlan(sameProjectSession.workspace.id)?.projectWorkflowKey,
    savedPlan.projectWorkflowKey,
  );
  assert.equal(firstStore.getGoal(sameProjectSession.workspace.id)?.objective, savedGoal.objective);
  assert.equal(firstStore.getCollaborationMode(sameProjectSession.workspace.id).mode, "plan");
  assert.equal(firstStore.getWorkflowDigest(sameProjectSession.workspace.id).hasActivePlan, true);
  assert.equal(firstStore.getWorkflowDigest(persistentWorktree.workspace.id).hasActivePlan, false);
  const blockedGoal = firstStore.updateGoalStatus({
    workspaceSessionId: persistentWorkspace.workspace.id,
    status: "blocked",
  });
  assert.equal(blockedGoal.status, "blocked");
  const restartedGoal = firstStore.saveGoal({
    workspaceSessionId: persistentWorkspace.workspace.id,
    objective: "Retry Codex-style planning support",
  });
  assert.equal(restartedGoal.status, "active");
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");
  const restoredPlan = secondStore.getPlan(persistentWorkspace.workspace.id);
  assert.equal(restoredPlan?.title, "Workflow state migration");
  assert.equal(restoredPlan?.summary, "Track work in small steps");
  assert.equal(restoredPlan?.steps[1]?.status, "in_progress");
  assert.equal(restoredPlan?.revision, 1);
  const restoredMode = secondStore.getCollaborationMode(persistentWorkspace.workspace.id);
  assert.equal(restoredMode.mode, "plan");
  const restoredPrompt = secondStore.getPendingUserInput(persistentWorkspace.workspace.id);
  assert.equal(restoredPrompt?.questions[0]?.id, "mode_choice");
  assert.equal(restoredPrompt?.autoResolutionMs, 60000);
  const restoredGoal = secondStore.getGoal(persistentWorkspace.workspace.id);
  assert.equal(restoredGoal?.objective, "Retry Codex-style planning support");
  assert.equal(restoredGoal?.status, "active");
  assert.equal(restoredGoal?.revision, 1);
  assert.equal("tokenBudget" in (restoredGoal ?? {}), false);
  assert.equal("timeUsedSeconds" in (restoredGoal ?? {}), false);
  assert.throws(
    () =>
      secondStore.saveGoal({
        workspaceSessionId: persistentWorkspace.workspace.id,
        objective: "Should fail while active goal exists",
      }),
    /An active goal already exists/,
  );
  const completedGoal = secondStore.updateGoalStatus({
    workspaceSessionId: persistentWorkspace.workspace.id,
    status: "complete",
  });
  assert.equal(completedGoal.status, "completed");

  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);
  secondStore.close();

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
