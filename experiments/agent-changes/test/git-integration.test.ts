import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { integrateGit, type GitCommandResult } from "../src/git-integration.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

function run(command: string): Promise<GitCommandResult> {
  try {
    const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return Promise.resolve({ exitCode: 0, stdout });
  } catch (error) {
    const code = (error as { status?: number }).status;
    return Promise.resolve({ exitCode: code ?? 1, stdout: "" });
  }
}

test("integrates a real agent fork and cleans failed attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-proposals-"));
  const base = join(root, "base.git");
  const fork = join(root, "fork.git");
  const source = join(root, "source");
  const candidate = join(root, "candidate");
  const integrationDir = `/tmp/agent-integration-${randomUUID()}`;
  try {
    git(root, "init", "--bare", "-b", "main", base);
    git(root, "init", "-b", "main", source);
    git(source, "config", "user.name", "Test Agent");
    git(source, "config", "user.email", "agent@example.invalid");
    writeFileSync(join(source, "feature.txt"), "baseline\n");
    git(source, "add", "feature.txt");
    git(source, "commit", "-m", "baseline");
    const baseline = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", base);
    git(source, "push", "origin", "main");
    git(root, "clone", "--bare", base, fork);
    git(root, "clone", fork, candidate);
    git(candidate, "config", "user.name", "Candidate Agent");
    git(candidate, "config", "user.email", "candidate@example.invalid");
    writeFileSync(join(candidate, "feature.txt"), "agent implementation\n");
    git(candidate, "commit", "-am", "Agent implementation");
    const head = git(candidate, "rev-parse", "HEAD");
    git(candidate, "push", "origin", "main");

    const input = {
      baseRemote: base, forkRemote: fork, baseCommit: baseline,
      headCommit: head, branch: "main", baseToken: "local-test", forkToken: "local-test",
    };
    let failed = false;
    await assert.rejects(integrateGit(input, integrationDir, async (command) => {
      if (!failed && command.includes(" push origin ")) {
        failed = true;
        throw new Error("Simulated transport failure");
      }
      return run(command);
    }), /Simulated transport failure/);
    assert.equal(existsSync(integrationDir), false, "failed attempt must not leave a checkout");
    assert.equal(git(root, "--git-dir", base, "rev-parse", "main"), baseline);

    const accepted = await integrateGit(input, integrationDir, run);
    assert.equal(accepted.status, "merged");
    assert.ok(accepted.commit);
    assert.equal(git(root, "--git-dir", base, "show", "main:feature.txt"), "agent implementation");
    assert.equal(existsSync(integrationDir), false, "successful attempt must not leave a checkout");
    await assert.rejects(integrateGit(input, integrationDir, run), /baseline has changed/);
  } finally {
    rmSync(integrationDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
