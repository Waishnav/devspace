import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Result, type Result as BetterResult } from "better-result";
import { loadConfig, type ServerConfig } from "./config.js";
import { cleanupManagedWorktrees, GitWorktreeError } from "./git-worktrees.js";
import {
  SqliteWorkspaceStore,
  type WorkspaceStoreError,
} from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    opened.workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [{
      name: "reviewer",
      description: "Read-only project reviewer.",
      provider: "codex",
      body: "Review only.",
    }],
  );

});

test("global instruction symlinks may target user-managed files outside agentDir", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const agentDir = join(context.root, ".codex-test");
  const dotfilesAgents = join(context.outsideRoot, "agents", ".codex");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dotfilesAgents, { recursive: true });
  await writeFile(join(dotfilesAgents, "AGENTS.md"), "dotfiles instructions\n");
  await symlink(join(dotfilesAgents, "AGENTS.md"), join(agentDir, "AGENTS.md"));

  const config = loadConfig(writeTestDevspaceConfig(
    join(context.root, ".devspace-dotfiles-home"),
    {
      server: { port: 1 },
      workspaces: {
        allowedRoots: [context.root],
        worktreeRoot: join(context.root, ".devspace", "dotfiles-worktrees"),
      },
      skills: { agentDir },
    },
  ));
  const opened = await new WorkspaceRegistry(config).openWorkspace(context.root);

  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["dotfiles instructions\n", "root instructions\n"],
  );
});

test("workspace instruction symlinks cannot escape the workspace", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const outsideInstructions = join(context.outsideRoot, "AGENTS.md");
  await writeFile(outsideInstructions, "outside instructions\n");
  await rm(join(context.root, "AGENTS.md"));
  await symlink(outsideInstructions, join(context.root, "AGENTS.md"));

  const opened = await context.registry.openWorkspace(context.root);

  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n"],
  );
});

test("opening a missing checkout creates its workspace root", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  const opened = await context.registry.openWorkspace(missingRoot);
  assert.equal(opened.workspace.root, missingRoot);
  assert.equal((await stat(missingRoot)).isDirectory(), true);
});

test("worktree opens require Git and create an isolated managed workspace", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "worktree");
  assert.notEqual(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.sourceRoot, gitRoot);
  assert.equal(opened.workspace.worktree?.baseRef, "HEAD");
  assert.equal(opened.workspace.worktree?.dirtySource, true);
  assert.equal(opened.workspace.worktree?.managed, true);
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const resolvedReadme = await context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme, await realpath(join(opened.workspace.root, "README.md")));
});

test("persisted checkout and worktree sessions restore after recreating the registry", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const worktree = await firstRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = await restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = await restoredRegistry.getWorkspace(worktree.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.equal(restoredWorktree.root, worktree.workspace.root);
    assert.equal(restoredWorktree.mode, "worktree");
    assert.equal(restoredWorktree.sourceRoot, gitRoot);
    assert.equal(restoredWorktree.worktree?.managed, true);
  } finally {
    secondStore.close();
  }
});

test("using a pruned workspace id restores its tracked worktree state", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-pruned-restore-state-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const registry = new WorkspaceRegistry(context.config, store);
  const opened = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const workspaceId = opened.workspace.id;
  const worktreePath = opened.workspace.root;

  await writeFile(join(worktreePath, "README.md"), "staged\n");
  await git(worktreePath, ["add", "README.md"]);
  await writeFile(join(worktreePath, "README.md"), "staged\nunstaged\n");

  unwrap(await cleanupManagedWorktrees({
    store,
    worktreeRoot: context.config.worktreeRoot,
    allowedRoots: context.config.allowedRoots,
    staleBefore: new Date(Date.now() + 60_000),
  }));

  assert.equal(store.getSession(workspaceId)?.status, "pruned");
  await assert.rejects(() => stat(worktreePath), /ENOENT/);

  const restored = await registry.getWorkspace(workspaceId);
  assert.equal(restored.id, workspaceId);
  assert.equal(restored.root, worktreePath);
  assert.equal(store.getSession(workspaceId)?.status, "active");
  assert.equal(await git(worktreePath, ["status", "--short"]), "MM README.md");
});

test("concurrent lookups share one pruned workspace restoration", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-pruned-concurrent-state-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const registry = new WorkspaceRegistry(context.config, store);
  const opened = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const workspaceId = opened.workspace.id;

  unwrap(await cleanupManagedWorktrees({
    store,
    worktreeRoot: context.config.worktreeRoot,
    allowedRoots: context.config.allowedRoots,
    staleBefore: new Date(Date.now() + 60_000),
  }));

  const [first, second] = await Promise.all([
    registry.getWorkspace(workspaceId),
    registry.getWorkspace(workspaceId),
  ]);

  assert.equal(first.id, workspaceId);
  assert.equal(second.id, workspaceId);
  assert.equal(first.root, second.root);
  assert.equal(store.getSession(workspaceId)?.status, "active");
});

test("failed session reactivation does not strand a restored worktree", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-pruned-reactivation-state-test-"));
  class FailOnceStore extends SqliteWorkspaceStore {
    private failNextReactivation = true;

    override reactivateSession(id: string): BetterResult<boolean, WorkspaceStoreError> {
      if (this.failNextReactivation) {
        this.failNextReactivation = false;
        return Result.ok(false);
      }
      return super.reactivateSession(id);
    }
  }
  const store = new FailOnceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const registry = new WorkspaceRegistry(context.config, store);
  const opened = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const workspaceId = opened.workspace.id;
  const worktreePath = opened.workspace.root;

  unwrap(await cleanupManagedWorktrees({
    store,
    worktreeRoot: context.config.worktreeRoot,
    allowedRoots: context.config.allowedRoots,
    staleBefore: new Date(Date.now() + 60_000),
  }));

  await assert.rejects(
    () => registry.getWorkspace(workspaceId),
    /could not be reactivated/,
  );
  assert.equal(store.getSession(workspaceId)?.status, "pruned");
  await assert.rejects(() => stat(worktreePath), /ENOENT/);

  const retried = await registry.getWorkspace(workspaceId);
  assert.equal(retried.id, workspaceId);
  assert.equal(store.getSession(workspaceId)?.status, "active");
});

test("invalid persisted roots are not refreshed before validation", async (t) => {
  const context = await fixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-invalid-root-state-test-"));
  class TrackingStore extends SqliteWorkspaceStore {
    touches = 0;

    override touchSession(id: string): BetterResult<boolean, WorkspaceStoreError> {
      this.touches += 1;
      return super.touchSession(id);
    }
  }
  const store = new TrackingStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const session = store.createSession({
    id: "ws_invalid_root",
    root: context.outsideRoot,
    mode: "checkout",
  });

  const registry = new WorkspaceRegistry(context.config, store);
  await assert.rejects(() => registry.getWorkspace(session.id), /outside allowed roots/);
  assert.equal(store.touches, 0);
});

test("persisted symlink roots cannot restore outside allowed roots", async (t) => {
  const context = await fixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-symlink-root-state-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outsideLink = join(context.root, "outside-link");
  await symlink(
    context.outsideRoot,
    outsideLink,
    platform() === "win32" ? "junction" : "dir",
  );
  const session = store.createSession({
    id: "ws_symlink_escape",
    root: outsideLink,
    mode: "checkout",
  });

  const registry = new WorkspaceRegistry(context.config, store);
  await assert.rejects(() => registry.getWorkspace(session.id), /outside allowed roots/);
});

test("workspace cache evicts old contexts without losing advertised skill reads", async (t) => {
  const context = await fixture(t);
  const stateDir = join(context.root, ".bounded-state");
  const agentDir = join(context.outsideRoot, "agent");
  const skillDir = join(agentDir, "skills", "cache-skill");
  const skillFile = join(skillDir, "SKILL.md");
  const resourceFile = join(skillDir, "reference.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillFile,
    [
      "---",
      "name: cache-skill",
      "description: Cache eviction regression skill.",
      "---",
      "",
      "Read the reference when needed.",
      "",
    ].join("\n"),
  );
  await writeFile(resourceFile, "reference\n");

  const configEnv = writeTestDevspaceConfig(
    join(context.root, ".bounded-home"),
    {
      server: { port: 1 },
      workspaces: {
        allowedRoots: [context.root],
        worktreeRoot: join(context.root, ".devspace", "bounded-worktrees"),
      },
      skills: { agentDir },
      subagents: { enabled: true, instructions: "on-demand", providers: [] },
    },
  );
  const config = loadConfig({
    ...configEnv,
    DEVSPACE_EXPERIMENTAL_SKILL_URIS: "1",
  });

  const store = new SqliteWorkspaceStore(stateDir);
  try {
    const registry = new WorkspaceRegistry(config, store);
    const first = await registry.openWorkspace(context.root);
    assert.equal(
      (
        await registry.resolveReadPath(
          first.workspace,
          "skills://cache-skill/reference.md",
        )
      ).absolutePath,
      await realpath(resourceFile),
    );

    for (let index = 0; index < 32; index += 1) {
      await registry.openWorkspace(context.root);
    }

    const restored = await registry.getWorkspace(first.workspace.id);
    assert.notEqual(restored, first.workspace);
    assert.equal(
      (
        await registry.resolveReadPath(
          restored,
          "skills://cache-skill/reference.md",
        )
      ).absolutePath,
      await realpath(resourceFile),
    );
  } finally {
    store.close();
  }
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("an opened workspace does not follow a retargeted root symlink", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const workspaceDirectory = join(context.root, "workspace-directory");
  const workspaceLink = join(context.root, "workspace-link");
  await mkdir(workspaceDirectory);
  await symlink(workspaceDirectory, workspaceLink, "dir");

  const opened = await context.registry.openWorkspace(workspaceLink);
  await rm(workspaceLink);
  await symlink(context.outsideRoot, workspaceLink, "dir");

  await assert.rejects(
    () => context.registry.getWorkspace(opened.workspace.id),
    /root changed after it was opened/,
  );
});

test("a symlinked allowed root preserves checkout and worktree path behavior", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig(writeTestDevspaceConfig(
    join(context.root, ".devspace-alias-home"),
    {
      server: { port: 1 },
      workspaces: {
        allowedRoots: [aliasRoot],
        worktreeRoot: join(aliasRoot, ".devspace", "alias-worktrees"),
      },
      skills: { agentDir: context.agentDir },
    },
  ));
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  const worktree = await aliasRegistry.openWorkspace({
    path: join(aliasRoot, "git-project"),
    mode: "worktree",
  });
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(worktree.workspace.sourceRoot, join(aliasRoot, "git-project"));
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(t: TestContext): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");

  if (platform() === "win32") {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }

  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".devspace-home"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".devspace", "worktrees"),
    },
    skills: { agentDir },
    subagents: { enabled: true, instructions: "on-demand", providers: [] },
  }));

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
