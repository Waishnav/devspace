import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Result, type Result as BetterResult } from "better-result";
import { LocalAgentManager } from "./local-agent-manager.js";
import type { AgentProviderError } from "./local-agent-errors.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
} from "./local-agent-runtime.js";
import { LocalAgentStore } from "./local-agent-store.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  constructor(private readonly workspaceRoot: string, private readonly runRoots: string[]) {}
  async run(_input: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.runRoots.push(this.workspaceRoot);
    return Result.ok({ provider: "codex", finalResponse: "done", providerSessionId: "session", items: [] });
  }
  async releaseSession(): Promise<void> {}
  isAlive(): boolean {
    return true;
  }
  async close(): Promise<void> {}
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

function code(result: BetterResult<unknown, unknown>): string | undefined {
  return result.isErr() ? (result.error as { code?: string }).code : undefined;
}

test("a worktree agent runs on a new branch at HEAD, under the worktree root, without uncommitted source changes", async (t) => {
  const { manager, source, worktreeRoot, runRoots, scope, start } = fixture(t);
  const created = unwrap(await start({ agentId: "job-1", worktree: {} }));
  assert.equal(created.workspaceRoot, source, "the agent stays scoped to the checkout it was started from");
  assert.equal(created.branch, "devspace/job-1");
  assert.ok(created.worktreePath?.startsWith(join(worktreeRoot, "app-")), created.worktreePath);
  assert.equal(git(created.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD"), "devspace/job-1");
  assert.equal(git(created.worktreePath!, "rev-parse", "HEAD"), git(source, "rev-parse", "HEAD"));
  assert.equal(existsSync(join(created.worktreePath!, "tracked.txt")), true);
  assert.equal(existsSync(join(created.worktreePath!, "uncommitted.txt")), false);
  unwrap(await manager.wait(["job-1"], scope, 2_000));
  assert.deepEqual(runRoots, [created.worktreePath], "the provider works in the worktree");
  const waited = unwrap(await manager.wait(["job-1"], scope, 0))[0];
  assert.equal(waited?.worktree, created.worktreePath, "wait reports the worktree");
  assert.equal(waited?.branch, "devspace/job-1");
  assert.equal(unwrap(manager.get("job-1", scope)).worktreePath, created.worktreePath);
});

test("a retried request id returns the same agent and creates no second worktree", async (t) => {
  const { manager, source, scope, start } = fixture(t);
  const created = unwrap(await start({ agentId: "job-1", worktree: {} }));
  unwrap(await manager.wait(["job-1"], scope, 2_000));

  const retried = unwrap(await start({ agentId: "job-1", worktree: {} }));
  assert.equal(retried.worktreePath, created.worktreePath);
  assert.equal(git(source, "worktree", "list").split("\n").length, 2);
  assert.equal(code(await start({ agentId: "job-1", worktree: { branch: "other" } })), "AGENT_CONFLICT");
  assert.equal(code(await start({ agentId: "job-1" })), "AGENT_CONFLICT", "dropping --worktree is a different dispatch");
});

test("a follow-up reuses the worktree", async (t) => {
  const { manager, runRoots, scope, start } = fixture(t);
  const created = unwrap(await start({ agentId: "job-1", worktree: {} }));
  unwrap(await manager.wait(["job-1"], scope, 2_000));

  unwrap(await manager.continue("job-1", "again", {}, scope));
  unwrap(await manager.wait(["job-1"], scope, 2_000));
  assert.deepEqual(runRoots, [created.worktreePath, created.worktreePath]);
});

test("agents without --worktree are unchanged and a ':' in the id cannot reach the branch name", async (t) => {
  const { start } = fixture(t);
  const plain = unwrap(await start({ agentId: "plain-1" }));
  assert.equal(plain.worktreePath, undefined);
  assert.equal(plain.branch, undefined);
  const colon = unwrap(await start({ agentId: "nightly:2026-08-21", worktree: {} }));
  assert.equal(colon.branch, "devspace/nightly-2026-08-21");
});

test("an explicit branch is used as given", async (t) => {
  const { start } = fixture(t);
  const named = unwrap(await start({ agentId: "job-2", worktree: { branch: "feature/probe" } }));
  assert.equal(named.branch, "feature/probe");
  assert.equal(git(named.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD"), "feature/probe");
});

// A failed creation leaves no record, so the same request id can be retried once the cause is fixed.
test("a failed worktree creation leaves no record so the request id can be retried", async (t) => {
  const { store, start } = fixture(t);
  unwrap(await start({ agentId: "job-2", worktree: { branch: "feature/probe" } }));

  const taken = await start({ agentId: "job-3", worktree: { branch: "feature/probe" } });
  assert.equal(code(taken), "WORKTREE_CREATE_FAILED");
  assert.match((taken as { error: Error }).error.message, /already exists/);
  assert.equal(store.getById("job-3"), undefined);
  assert.equal(unwrap(await start({ agentId: "job-3", worktree: { branch: "feature/other" } })).branch, "feature/other");
});

// Outside a git repository the error is typed and names the problem.
test("a worktree agent outside a git repository fails with a typed error", async (t) => {
  const { store, notGit, start } = fixture(t);
  const outside = await start({ worktree: {}, workspaceRoot: notGit });
  assert.equal(code(outside), "WORKTREE_NOT_GIT_REPOSITORY");
  assert.equal((outside as { error: { agentId?: string } }).error.agentId, undefined, "the rolled-back id is not reported");
  assert.match((outside as { error: Error }).error.message, /needs a git repository/);
  assert.deepEqual(store.list({ workspaceRoot: notGit }), []);
});

test("a removed worktree fails the follow-up clearly instead of running in the source checkout", async (t) => {
  const { manager, source, scope, start } = fixture(t);
  const named = unwrap(await start({ agentId: "job-2", worktree: { branch: "feature/probe" } }));
  unwrap(await manager.wait(["job-2"], scope, 2_000));

  git(source, "worktree", "remove", "--force", named.worktreePath!);
  const missing = await manager.continue("job-2", "again", {}, scope);
  assert.equal(code(missing), "WORKTREE_MISSING");
  assert.match((missing as { error: Error }).error.message, /git worktree add/);
});

test("the worktree survives a daemon restart", async (t) => {
  const { manager, temp, scope, start } = fixture(t);
  const created = unwrap(await start({ agentId: "job-1", worktree: {} }));
  unwrap(await manager.wait(["job-1"], scope, 2_000));

  await manager.close();
  // The worktree survives a daemon restart, which is when a later `continue` reads it back.
  const reopened = new LocalAgentStore(join(temp, "state"));
  assert.equal(reopened.getById("job-1")?.worktreePath, created.worktreePath);
  assert.equal(reopened.getById("job-1")?.branch, "devspace/job-1");
  reopened.close();
});

function fixture(t: TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "devspace-agent-worktree-test-")));
  const worktreeRoot = join(temp, "worktrees");
  const source = join(temp, "app");
  const notGit = join(temp, "plain");
  mkdirSync(source);
  mkdirSync(notGit);

  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  writeFileSync(join(source, "tracked.txt"), "tracked\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "initial");
  writeFileSync(join(source, "uncommitted.txt"), "not copied\n");

  /** The workspace root each run was given, to prove where the provider actually works. */
  const runRoots: string[] = [];
  const driver: LocalAgentDriver = {
    providerInstanceId: "codex",
    provider: "codex",
    runtimePolicy: { scope: "agent" },
    capabilities: {
      sessions: { resume: true, close: false },
      turns: { interrupt: true, streaming: true },
      configuration: { modelOverride: true, effortOverride: true },
      permissions: { enforcement: "native" },
      mcp: { supported: false },
    },
    createRuntime: async (context) => Result.ok(new FakeRuntime(context.workspaceRoot, runRoots)),
  };

  const store = new LocalAgentStore(join(temp, "state"));
  const manager = new LocalAgentManager({
    store,
    drivers: [driver],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [],
    worktreeRoot,
    subagents: { enabled: true, instructions: "on-demand", providers: [{ id: "codex", driver: "codex", enabled: true }] },
  });
  t.after(async () => {
    await manager.close();
    rmSync(temp, { recursive: true, force: true });
  });

  const scope = { workspaceRoot: source };
  const start = (extra: { agentId?: string; worktree?: { branch?: string }; workspaceRoot?: string }) =>
    manager.start({ target: "codex", prompt: "go", workspaceRoot: source, writeMode: "full_access", ...extra });

  return { temp, worktreeRoot, source, notGit, runRoots, store, manager, scope, start };
}
