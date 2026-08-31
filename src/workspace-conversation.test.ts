import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("a conversation reuses its checkout context", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(second.workspace.id, first.workspace.id);
  assert.deepEqual(second.agentsFiles, first.agentsFiles);
  assert.deepEqual(second.availableAgentsFiles, first.availableAgentsFiles);
  assert.deepEqual(second.workspace.skills, first.workspace.skills);
  assert.deepEqual(second.workspace.skillDiagnostics, first.workspace.skillDiagnostics);
  assert.deepEqual(second.workspace.agentProfiles, first.workspace.agentProfiles);
});

test("different conversations receive separate checkout workspaces", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.notEqual(second.workspace.id, first.workspace.id);
});

test("conversation bindings distinguish canonical projects", async (t) => {
  const { root, project, registry } = await fixture(t);
  const otherProject = join(root, "other-project");
  await mkdir(otherProject);
  await writeFile(join(otherProject, "AGENTS.md"), "other project instructions\n");

  const firstProjectOpen = await registry.openWorkspace(project, {
    conversationScopeId: "chat-1",
  });
  const otherProjectOpen = await registry.openWorkspace(otherProject, {
    conversationScopeId: "chat-1",
  });
  const repeatedProjectOpen = await registry.openWorkspace(project, {
    conversationScopeId: "chat-1",
  });
  const repeatedOtherProjectOpen = await registry.openWorkspace(otherProject, {
    conversationScopeId: "chat-1",
  });

  assert.equal(repeatedProjectOpen.workspace.id, firstProjectOpen.workspace.id);
  assert.equal(repeatedOtherProjectOpen.workspace.id, otherProjectOpen.workspace.id);
  assert.notEqual(otherProjectOpen.workspace.id, firstProjectOpen.workspace.id);
});

test("concurrent checkout opens reuse one workspace and return matching context", async (t) => {
  const { project, registry } = await fixture(t);

  const opens = await Promise.all([
    registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
  ]);

  assert.equal(new Set(opens.map((open) => open.workspace.id)).size, 1);
  assert.deepEqual(opens[0].agentsFiles, opens[1].agentsFiles);
  assert.deepEqual(opens[0].availableAgentsFiles, opens[1].availableAgentsFiles);
});

test("a checkout without a conversation scope does not use conversation reuse", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project);
  const second = await registry.openWorkspace(project);

  assert.notEqual(second.workspace.id, first.workspace.id);
});

test("worktree requests remain fresh without replacing the reusable checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const firstWorktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const secondWorktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(firstWorktree.workspace.id, secondWorktree.workspace.id);
  assert.notEqual(firstWorktree.workspace.root, secondWorktree.workspace.root);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("a worktree-first conversation creates and then reuses its checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const worktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(checkout.workspace.mode, "checkout");
  assert.notEqual(checkout.workspace.id, worktree.workspace.id);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("concurrent worktree opens remain fresh and return complete context", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const [first, second] = await Promise.all([
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
  ]);

  assert.notEqual(first.workspace.id, second.workspace.id);
  assert.notEqual(first.workspace.root, second.workspace.root);
  assert.deepEqual(
    first.agentsFiles.map((file) => file.content),
    second.agentsFiles.map((file) => file.content),
  );
  assert.deepEqual(
    first.availableAgentsFiles.map((file) => file.path.replace(first.workspace.root, "<root>")),
    second.availableAgentsFiles.map((file) => file.path.replace(second.workspace.root, "<root>")),
  );
});

test("checkout reuse survives a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const restored = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.equal(restored.workspace.id, first.workspace.id);
});

test("a failed first context load does not consume bootstrap", async (t) => {
  const { project, registry } = await fixture(t);
  const agentsDir = join(project, ".devspace", "agents");
  const backupDir = join(project, ".devspace", "agents-backup");

  await breakAgentsDirectory(agentsDir, backupDir);
  try {
    await assert.rejects(
      () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
      /directory|ENOTDIR/i,
    );
  } finally {
    await restoreAgentsDirectory(agentsDir, backupDir);
  }

  const successfulOpen = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
});

test("a context-loading failure preserves a valid checkout binding", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const agentsDir = join(project, ".devspace", "agents");
  const backupDir = join(project, ".devspace", "agents-backup");

  await breakAgentsDirectory(agentsDir, backupDir);
  try {
    await assert.rejects(
      () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
      /directory|ENOTDIR/i,
    );
  } finally {
    await restoreAgentsDirectory(agentsDir, backupDir);
  }

  const recovered = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(recovered.workspace.id, first.workspace.id);
});

test("a deleted checkout is replaced with a new workspace", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  await rm(project, { recursive: true, force: true });
  const replacement = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
  assert.equal((await stat(project)).isDirectory(), true);
});

test("canonical checkout identity remains stable when the requested target starts missing", async (t) => {
  const { project, registry } = await fixture(t);
  const missingTarget = join(project, "generated", "checkout");

  const first = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });

  assert.equal(first.workspace.root, missingTarget);
  assert.equal(second.workspace.id, first.workspace.id);
});

test("canonical checkout identity survives equivalent path and symlink aliases", async (t) => {
  const { root, project, registry } = await fixture(t);

  const direct = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const equivalent = await registry.openWorkspace(join(project, "..", "project"), {
    conversationScopeId: "chat-1",
  });

  assert.equal(equivalent.workspace.id, direct.workspace.id);

  if (platform() === "win32") return;

  const alias = join(root, "project-alias");
  await symlink(project, alias, "dir");
  const aliased = await registry.openWorkspace(alias, { conversationScopeId: "chat-1" });

  assert.equal(aliased.workspace.id, direct.workspace.id);
});

test("canonical checkout identity survives macOS var path aliases", { skip: platform() !== "darwin" }, async (t) => {
  const context = await fixture(t);
  const macAlias = context.root.startsWith("/private/var/")
    ? `/var/${context.root.slice("/private/var/".length)}`
    : context.root.startsWith("/var/")
      ? `/private/var/${context.root.slice("/var/".length)}`
      : undefined;
  if (!macAlias) {
    t.skip("temporary directory is not under /var");
    return;
  }

  const aliasConfig = loadConfig(writeTestDevspaceConfig(join(context.root, ".alias-config"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [context.root, macAlias],
      worktreeRoot: join(context.root, ".worktrees"),
    },
    skills: { agentDir: join(context.root, "agent") },
  }));
  const aliasRegistry = new WorkspaceRegistry(aliasConfig, context.store);

  const direct = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  const aliased = await aliasRegistry.openWorkspace(
    `${macAlias}/${context.project.slice(context.root.length + 1)}`,
    { conversationScopeId: "chat-1" },
  );

  assert.equal(aliased.workspace.id, direct.workspace.id);
});

test("an invalid persisted checkout binding is not reused", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set mode = 'worktree' where id = ?")
      .run(first.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const replacement = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
});

test("an inactive persisted checkout binding is not reused", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set status = 'inactive' where id = ?")
      .run(first.workspace.id);
  } finally {
    database.close();
  }

  const restoredRegistry = new WorkspaceRegistry(context.config, context.openStore());
  const replacement = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
});

test("a checkout replaced by a file reports the filesystem error", async (t) => {
  const context = await fixture(t);
  const target = join(context.root, "file-target");
  await context.registry.openWorkspace(target, { conversationScopeId: "chat-1" });
  await rm(target, { recursive: true, force: true });
  await writeFile(target, "not a directory\n");

  await assert.rejects(
    () => context.registry.openWorkspace(target, { conversationScopeId: "chat-1" }),
    /Workspace root must be a directory/,
  );
});

test("unexpected storage errors are not mistaken for stale bindings", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" });
  const targetKey = checkoutTargetKey(await realpath(context.project));
  context.closeStore(context.store);

  await assert.rejects(
    () => context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" }),
  );

  const restoredStore = context.openStore();
  assert.equal(
    restoredStore.getConversationBinding("chat-1", targetKey)?.workspaceSessionId,
    first.workspace.id,
  );
});

test("unexpected filesystem errors are propagated without replacing the binding", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" });
  const targetKey = checkoutTargetKey(await realpath(context.project));
  const loopA = join(context.root, "loop-a");
  const loopB = join(context.root, "loop-b");

  await symlink(loopB, loopA, "dir");
  await symlink(loopA, loopB, "dir");
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set root = ? where id = ?")
      .run(loopA, first.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  await assert.rejects(
    () => restoredRegistry.openWorkspace(context.project, { conversationScopeId: "chat-1" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ELOOP",
  );

  const binding = restoredStore.getConversationBinding("chat-1", targetKey);
  assert.equal(binding?.workspaceSessionId, first.workspace.id);
  assert.equal(restoredStore.getSession(first.workspace.id)?.root, loopA);
});

interface WorkspaceFixture {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  store: SqliteWorkspaceStore;
  registry: WorkspaceRegistry;
  openStore: () => SqliteWorkspaceStore;
  closeStore: (store: SqliteWorkspaceStore) => void;
}

async function fixture(
  t: TestContext,
  options: { git?: boolean } = {},
): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-conversation-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  const stores = new Set<SqliteWorkspaceStore>();

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) await initializeGitRepository(project);

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: { enabled: true, providers: [] },
  }));
  const openStore = () => {
    const store = new SqliteWorkspaceStore(stateDir);
    stores.add(store);
    return store;
  };
  const closeStore = (store: SqliteWorkspaceStore) => {
    if (stores.delete(store)) store.close();
  };
  const store = openStore();

  t.after(async () => {
    for (const openStore of stores) openStore.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    stateDir,
    config,
    store,
    registry: new WorkspaceRegistry(config, store),
    openStore,
    closeStore,
  };
}

async function breakAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rename(agentsDir, backupDir);
  await writeFile(agentsDir, "not a directory\n");
}

async function restoreAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rm(agentsDir, { force: true });
  await rename(backupDir, agentsDir);
}

async function initializeGitRepository(root: string): Promise<void> {
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function checkoutTargetKey(project: string): string {
  return JSON.stringify(["checkout", project, null]);
}
