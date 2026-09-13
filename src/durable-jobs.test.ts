import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJobManager } from "./durable-jobs.js";
import { resolveProjectEnvironment, getRuntimeDiagnostics } from "./runtime-env.js";

function delay(ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  return new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  }).finally(() => {
    clearTimeout(timer);
  });
}

test("DurableJobManager: starts, tracks, and reads logs from detached job", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-test-"));
  const mgr = new DurableJobManager(tempDir);

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: "echo line1; echo line2",
      workingDirectory: process.cwd(),
    });

    assert.ok(job.id.startsWith("job_"));
    assert.equal(job.status, "running");

    // Wait for completion
    let finalJob = mgr.getJob(job.id);
    for (let i = 0; i < 20; i++) {
      if (finalJob?.status !== "running") break;
      await delay(100);
      finalJob = mgr.getJob(job.id);
    }

    assert.equal(finalJob?.status, "succeeded");
    assert.equal(finalJob?.exitCode, 0);

    const logs = mgr.readLogs(job.id);
    assert.ok(logs.content.includes("line1"));
    assert.ok(logs.content.includes("line2"));
    assert.equal(logs.hasMore, false);
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: cancels running job and updates record", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-cancel-test-"));
  const mgr = new DurableJobManager(tempDir);

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: "sleep 60",
      workingDirectory: process.cwd(),
    });

    assert.equal(job.status, "running");
    const cancelRes = mgr.cancelJob(job.id);
    assert.equal(cancelRes.success, true);

    const postCancel = mgr.getJob(job.id);
    assert.equal(postCancel?.status, "cancelled");
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Runtime environment normalization and diagnostics", () => {
  const env = resolveProjectEnvironment(process.cwd());
  assert.ok(typeof env.PATH === "string");
  assert.ok(env.SHELL);

  const diag = getRuntimeDiagnostics(process.cwd());
  assert.ok(diag.nodeVersion);
  assert.ok(diag.gitVersion);
  assert.ok(diag.shell);
});
