import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    phases: [
      { title: "Planning", detail: "Understand the change" },
      { title: "Review" },
    ],
  });

  assert.match(run.id, /^wfr_[a-f0-9]{12}$/);
  assert.equal(run.status, "starting");
  assert.equal(run.cancelRequested, false);
  assert.equal(store.getRun(run.id)?.name, "fanout");
  assert.deepEqual(store.getRun(run.id)?.phases, [
    { title: "Planning", detail: "Understand the change" },
    { title: "Review" },
  ]);

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
  assert.equal(page1.hasMore, true);
  assert.equal(page1.terminal, false);

  const page2 = store.drainEvents(run.id, 2, 10);
  assert.equal(page2.events.length, 1);
  assert.equal(page2.events[0]?.seq, 3);
  assert.equal(page2.nextSeq, 3);
  assert.equal(page2.hasMore, false);

  store.startAgentCall({
    runId: run.id,
    callIndex: 0,
    cacheKey: "key-a",
    prompt: "review",
    schemaJson: JSON.stringify({ type: "object" }),
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
    profileName: "reviewer",
    profileFingerprint: "profile-hash",
    phase: "Review",
    isolation: "worktree",
    worktreePath: "/tmp/wt",
    replayReason: "identity_changed:prompt",
  });
  store.attachAgentSession(run.id, 0, "sess_live");
  const partialUsage = store.updateAgentUsage(run.id, 0, {
    inputTokens: 1_000,
    cachedInputTokens: 700,
    outputTokens: 200,
    totalTokens: 1_200,
    state: "partial",
  });
  assert.equal(partialUsage.state, "partial");
  store.appendAgentActivity({
    runId: run.id,
    callIndex: 0,
    kind: "command",
    status: "running",
    label: "npm test",
  });
  store.appendAgentActivity({
    runId: run.id,
    callIndex: 0,
    kind: "command",
    status: "completed",
    label: "npm test",
    detail: "passed",
  });
  assert.deepEqual(
    store.listAgentActivity(run.id, 0).map((activity) => activity.status),
    ["running", "completed"],
  );
  store.completeAgentCall({
    runId: run.id,
    callIndex: 0,
    responseText: "done",
    structuredJson: JSON.stringify({ ok: true }),
    returnValueJson: JSON.stringify({ ok: true, exact: true }),
    providerSessionId: "sess_1",
    dirty: true,
  });
  store.updateAgentUsage(run.id, 0, {
    inputTokens: 1_100,
    cachedInputTokens: 700,
    outputTokens: 250,
    totalTokens: 1_350,
    state: "final",
  });
  const call = store.getAgentCall(run.id, 0);
  assert.equal(call?.status, "completed");
  assert.equal(call?.isolation, "worktree");
  assert.equal(call?.dirty, true);
  assert.equal(call?.providerSessionId, "sess_1");
  assert.equal(call?.usage?.totalTokens, 1_350);
  assert.equal(call?.usage?.state, "final");
  assert.equal(call?.effort, "high");
  assert.equal(call?.profileName, "reviewer");
  assert.equal(call?.profileFingerprint, "profile-hash");
  assert.equal(call?.prompt, "review");
  assert.equal(call?.returnValueJson, JSON.stringify({ ok: true, exact: true }));
  assert.equal(call?.replayReason, "identity_changed:prompt");
  assert.deepEqual(
    store.listEvents(run.id).slice(-2).map((event) => event.type),
    ["agent_call_started", "agent_call_completed"],
  );

  store.startAgentCall({
    runId: run.id,
    callIndex: 1,
    cacheKey: "key-b",
    prompt: "review two",
    provider: "claude",
  });
  store.failAgentCall({
    runId: run.id,
    callIndex: 1,
    error: "boom",
    errorKind: "provider",
  });
  assert.equal(store.getAgentCall(run.id, 1)?.status, "failed");
  assert.equal(store.getAgentCall(run.id, 1)?.errorKind, "provider");
  assert.equal(store.listAgentCalls(run.id).length, 2);
  assert.deepEqual(
    store.listEvents(run.id).slice(-2).map((event) => event.type),
    ["agent_call_started", "agent_call_failed"],
  );

  const cancelled = store.requestCancel(run.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(store.isCancelRequested(run.id), true);

  const terminal = store.cancelRun(run.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.errorKind, "cancelled");
  assert.equal(store.cancelRun(run.id).status, "cancelled");

  const terminalPage1 = store.drainEvents(run.id, 0, 2);
  assert.equal(terminalPage1.hasMore, true);
  assert.equal(terminalPage1.terminal, false);
  const drainDone = store.drainEvents(run.id, 0, 100);
  assert.equal(drainDone.events.at(-1)?.type, "run_cancelled");
  assert.equal(drainDone.hasMore, false);
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

  const otherProjectRun = store.createRun({
    name: "other-project",
    source: "inline",
    scriptPath: join(root, "other.js"),
    scriptHash: "other",
    workspaceRoot: join(root, "other-project"),
  });
  const otherWorkspaceRun = store.createRun({
    name: "other-workspace",
    source: "inline",
    scriptPath: join(root, "other-workspace.js"),
    scriptHash: "other-workspace",
    workspaceRoot: join(root, "project"),
    workspaceId: "ws_2",
  });
  assert.deepEqual(
    store
      .listRunsForWorkspace(join(root, "project"))
      .map((entry) => entry.id)
      .sort(),
    [run.id, run2.id, otherWorkspaceRun.id].sort(),
  );
  assert.deepEqual(
    store
      .listRunsForScope({
        workspaceId: "ws_1",
        workspaceRoot: join(root, "project"),
      })
      .map((entry) => entry.id)
      .sort(),
    [run.id, run2.id].sort(),
  );
  assert.deepEqual(
    store.listRunsForScope({
      workspaceId: "ws_1",
      workspaceRoot: join(root, "project"),
    }, { statuses: ["completed"] }).map((entry) => entry.id),
    [run2.id],
  );
  assert.deepEqual(
    store
      .listRunsForWorkspace(join(root, "project"), { statuses: ["completed"] })
      .map((entry) => entry.id),
    [run2.id],
  );
  assert.equal(
    store.listRunsForWorkspace(join(root, "other-project"))[0]?.id,
    otherProjectRun.id,
  );
  assert.deepEqual(
    store.listEvents(run.id, 2).map((event) => event.type),
    ["agent_call_failed", "run_cancelled"],
  );

  // Reap: stale heartbeat + dead pid (force heartbeat via shared sqlite handle)
  const run3 = store.createRun({
    name: "stale",
    source: "inline",
    scriptPath: join(root, "s.js"),
    scriptHash: "h3",
    workspaceRoot: join(root, "project"),
  });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid);
  store.claimRun(run3.id, dead.pid);
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
  assert.equal(store.listEvents(run3.id).at(-1)?.type, "run_failed");

  const runStarting = store.createRun({
    name: "never-started",
    source: "inline",
    scriptPath: join(root, "never.js"),
    scriptHash: "never",
    workspaceRoot: join(root, "project"),
  });
  const staleStartingDb = openDatabase(root);
  try {
    staleStartingDb.sqlite
      .prepare(`update workflow_runs set updated_at = ? where id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), runStarting.id);
  } finally {
    staleStartingDb.close();
  }
  const reapedStarting = store.reapStale(60_000);
  assert.ok(reapedStarting.some((entry) => entry.id === runStarting.id));
  assert.equal(store.getRun(runStarting.id)?.status, "failed");

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

  const atomicRun = store.createRun({
    name: "atomic-agent-calls",
    source: "inline",
    scriptPath: join(root, "atomic.js"),
    scriptHash: "atomic",
    workspaceRoot: join(root, "project"),
  });
  store.claimRun(atomicRun.id, process.pid);
  const atomicDb = openDatabase(root);
  try {
    atomicDb.sqlite.exec(`
      create trigger reject_agent_call_started
      before insert on workflow_events
      when new.type = 'agent_call_started'
      begin
        select raise(abort, 'reject started event');
      end;
    `);
    assert.throws(() =>
      store.startAgentCall({
        runId: atomicRun.id,
        callIndex: 0,
        cacheKey: "atomic-start",
        prompt: "start",
        provider: "codex",
      }),
    );
    assert.equal(store.getAgentCall(atomicRun.id, 0), undefined);
    atomicDb.sqlite.exec(`drop trigger reject_agent_call_started`);

    store.startAgentCall({
      runId: atomicRun.id,
      callIndex: 0,
      cacheKey: "atomic-start",
      prompt: "start",
      provider: "codex",
    });
    atomicDb.sqlite.exec(`
      create trigger reject_agent_call_completed
      before insert on workflow_events
      when new.type = 'agent_call_completed'
      begin
        select raise(abort, 'reject completed event');
      end;
    `);
    assert.throws(() =>
      store.completeAgentCall({
        runId: atomicRun.id,
        callIndex: 0,
        responseText: "done",
        returnValueJson: JSON.stringify("done"),
      }),
    );
    assert.equal(store.getAgentCall(atomicRun.id, 0)?.status, "running");
    atomicDb.sqlite.exec(`drop trigger reject_agent_call_completed`);

    store.completeAgentCall({
      runId: atomicRun.id,
      callIndex: 0,
      responseText: "done",
      returnValueJson: JSON.stringify("done"),
    });

    atomicDb.sqlite.exec(`
      create trigger reject_agent_call_cached
      before insert on workflow_events
      when new.type = 'agent_call_cached'
      begin
        select raise(abort, 'reject cached event');
      end;
    `);
    assert.throws(() =>
      store.cacheAgentCall({
        runId: atomicRun.id,
        callIndex: 1,
        cacheKey: "atomic-cache",
        prompt: "cached",
        provider: "codex",
        replayMatch: "same_index",
        replayedFromRunId: "wfr_prior",
        replayedFromCallIndex: 0,
        responseText: "cached",
        returnValueJson: JSON.stringify("cached"),
      }),
    );
    assert.equal(store.getAgentCall(atomicRun.id, 1), undefined);
    atomicDb.sqlite.exec(`drop trigger reject_agent_call_cached`);
  } finally {
    atomicDb.close();
  }

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
