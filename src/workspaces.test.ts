import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context while filtering outside symlinks", async (t) => {
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

  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig(writeTestDevspaceConfig(
      join(context.root, ".devspace-unsafe-home"),
      {
        server: { port: 1 },
        workspaces: {
          allowedRoots: [context.root],
          worktreeRoot: join(context.root, ".devspace", "unsafe-worktrees"),
        },
        skills: { agentDir: unsafeAgentDir },
      },
    ));
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }
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

  const resolvedReadme = context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme.startsWith(opened.workspace.root), true);
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
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = restoredRegistry.getWorkspace(worktree.workspace.id);

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

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("workspace paths cannot escape allowed roots through symlinks", async (t) => {
  const context = await fixture(t);
  const outsideLink = join(context.root, "outside-link");
  await symlink(
    context.outsideRoot,
    outsideLink,
    platform() === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => context.registry.openWorkspace(outsideLink),
    /outside allowed roots/,
  );
  await assert.rejects(
    () => context.registry.openWorkspace({ path: outsideLink, mode: "worktree" }),
    /outside allowed roots/,
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
    subagents: { enabled: true, providers: [] },
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
