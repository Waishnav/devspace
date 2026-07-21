import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { WorkflowStore } from "./workflow-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-store-test-"));
const stores: WorkflowStore[] = [];

try {
  const store = new WorkflowStore(root);
  stores.push(store);

  const run = store.createRun({
    name: "fanout",
    source: "inline",
    scriptPath: join(root, "runs", "wfr_test.js"),
    scriptHash: "abc123",
    workspaceRoot: join(root, "project"),
    workspaceId: "ws_1",
    argsJson: JSON.stringify({ files: ["a.ts"] }),
  });

  assert.match(run.id, /^wfr_[a-f0-9]{12}$/);
  assert.equal(run.status, "starting");
  assert.equal(run.cancelRequested, false);
  assert.equal(store.getRun(run.id)?.name, "fanout");

  const claimed = store.claimRun(run.id, process.pid);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.pid, process.pid);
  assert.ok(claimed?.startedAt);
  assert.equal(store.claimRun(run.id, 99999), undefined);

  store.setHeartbeat(run.id);
  assert.ok(store.getRun(run.id)?.heartbeatAt);

  const e1 = store.appendEvent({
    runId: run.id,
    type: "run_started",
    data: { name: run.name, scriptHash: run.scriptHash, concurrency: 1 },
  });
  const e2 = store.appendEvent({
    runId: run.id,
    type: "phase_started",
    phase: "Review",
    label: "r1",
    data: { title: "Review" },
  });
  const e3 = store.appendEvent({ runId: run.id, type: "log", data: { message: "hello" } });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);

  const page1 = store.drainEvents(run.id, 0, 2);
  assert.equal(page1.events.length, 2);
  assert.equal(page1.nextSeq, 2);
  assert.equal(page1.terminal, false);

  const page2 = store.drainEvents(run.id, 2, 10);
  assert.equal(page2.events.length, 1);
  assert.equal(page2.events[0]?.seq, 3);
  assert.equal(page2.nextSeq, 3);

  store.beginAgentCall({
    runId: run.id,
    callIndex: 0,
    cacheKey: "key-a",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
    phase: "Review",
    isolation: "worktree",
    worktreePath: "/tmp/wt",
  });
  store.completeAgentCall({
    runId: run.id,
    callIndex: 0,
    responseText: "done",
    structuredJson: JSON.stringify({ ok: true }),
    providerSessionId: "sess_1",
    dirty: true,
  });
  const call = store.getAgentCall(run.id, 0);
  assert.equal(call?.status, "completed");
  assert.equal(call?.isolation, "worktree");
  assert.equal(call?.dirty, true);
  assert.equal(call?.providerSessionId, "sess_1");
  assert.equal(call?.effort, "high");

  store.beginAgentCall({
    runId: run.id,
    callIndex: 1,
    cacheKey: "key-b",
    provider: "claude",
  });
  store.failAgentCall({ runId: run.id, callIndex: 1, error: "boom" });
  assert.equal(store.getAgentCall(run.id, 1)?.status, "failed");
  assert.equal(store.listAgentCalls(run.id).length, 2);

  const cancelled = store.requestCancel(run.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(store.isCancelRequested(run.id), true);

  const terminal = store.cancelRun(run.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.errorKind, "cancelled");
  assert.equal(store.cancelRun(run.id).status, "cancelled");

  const drainDone = store.drainEvents(run.id, 0, 100);
  assert.equal(drainDone.terminal, true);

  const run2 = store.createRun({
    name: "done",
    source: "named",
    scriptPath: join(root, "x.js"),
    scriptHash: "h2",
    workspaceRoot: join(root, "project"),
  });
  store.claimRun(run2.id, process.pid);
  store.completeRun(run2.id, { resultJson: JSON.stringify({ ok: 1 }) });
  assert.equal(store.getRun(run2.id)?.status, "completed");
  assert.equal(store.getRun(run2.id)?.resultJson, JSON.stringify({ ok: 1 }));

  // Reap: stale heartbeat + dead pid (force heartbeat via shared sqlite handle)
  const run3 = store.createRun({
    name: "stale",
    source: "inline",
    scriptPath: join(root, "s.js"),
    scriptHash: "h3",
    workspaceRoot: join(root, "project"),
  });
  store.claimRun(run3.id, 2_147_483_646);
  const db = openDatabase(root);
  try {
    db.sqlite
      .prepare(`update workflow_runs set heartbeat_at = ? where id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), run3.id);
  } finally {
    db.close();
  }
  const reaped = store.reapStale(60_000);
  assert.ok(reaped.some((r) => r.id === run3.id && r.status === "failed"));
  assert.equal(store.getRun(run3.id)?.errorKind, "heartbeat");

  const run4 = store.createRun({
    name: "seq",
    source: "inline",
    scriptPath: join(root, "seq.js"),
    scriptHash: "h4",
    workspaceRoot: join(root, "project"),
  });
  const seqs = [0, 1, 2, 3, 4].map(() =>
    store.appendEvent({ runId: run4.id, type: "log", data: { message: "1" } }).seq,
  );
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);

  assert.ok(store.listRuns().length >= 3);

  // Second store instance sees same rows
  const other = new WorkflowStore(root);
  stores.push(other);
  assert.equal(other.getRun(run.id)?.status, "cancelled");
} finally {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("workflow-store.test.ts: ok");
