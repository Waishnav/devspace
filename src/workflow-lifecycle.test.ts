import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelWorkflowRun,
  type WorkflowLifecycleRuntime,
} from "./workflow-lifecycle.js";
import { WorkflowStore } from "./workflow-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-lifecycle-test-"));
const store = new WorkflowStore(root);

try {
  {
    const run = createRunningRun(store, root, "cooperative", 101);
    const signals: NodeJS.Signals[] = [];
    let slept = false;
    const runtime: WorkflowLifecycleRuntime = {
      sleep: async () => {
        if (!slept) {
          slept = true;
          store.cancelRun(run.id, "worker observed cancellation");
        }
      },
      terminate: (_pid, signal) => signals.push(signal),
    };
    const cancelled = await cancelWorkflowRun(store, run.id, {
      graceMs: 100,
      pollMs: 1,
      runtime,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(signals, []);
  }

  {
    const run = createRunningRun(store, root, "hard", 202);
    const signals: NodeJS.Signals[] = [];
    const runtime: WorkflowLifecycleRuntime = {
      sleep: async () => {},
      terminate: (_pid, signal) => signals.push(signal),
    };
    const cancelled = await cancelWorkflowRun(store, run.id, {
      graceMs: 0,
      termWaitMs: 0,
      runtime,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(store.listEvents(run.id).at(-1)?.type, "run_cancelled");
  }

  {
    const run = store.createRun({
      name: "not-claimed",
      source: "inline",
      scriptPath: "inline",
      scriptHash: "h",
      workspaceRoot: root,
    });
    const signals: NodeJS.Signals[] = [];
    const cancelled = await cancelWorkflowRun(store, run.id, {
      graceMs: 0,
      termWaitMs: 0,
      runtime: {
        sleep: async () => {},
        terminate: (_pid, signal) => signals.push(signal),
      },
    });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(signals, []);
  }

  {
    const run = createRunningRun(store, root, "already-done", 303);
    store.completeRun(run.id, { callCount: 0 });
    const signals: NodeJS.Signals[] = [];
    const completed = await cancelWorkflowRun(store, run.id, {
      runtime: {
        sleep: async () => {},
        terminate: (_pid, signal) => signals.push(signal),
      },
    });
    assert.equal(completed.status, "completed");
    assert.deepEqual(signals, []);
  }
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

function createRunningRun(
  workflowStore: WorkflowStore,
  workspaceRoot: string,
  name: string,
  pid: number,
) {
  const run = workflowStore.createRun({
    name,
    source: "inline",
    scriptPath: "inline",
    scriptHash: "h",
    workspaceRoot,
  });
  return workflowStore.claimRun(run.id, pid)!;
}

console.log("workflow-lifecycle.test.ts: ok");
