import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAgentClient } from "./local-agent-client.js";
import { LocalAgentDaemon, type LocalAgentDaemonManager } from "./local-agent-daemon.js";
import type { WorkflowReply } from "./workflow-protocol.js";

test("workflow daemon transport preserves active runs and allows observation after config changes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workflow-daemon-"));
  let activeRuns = 1;
  let closed = false;
  const manager = {
    activeTurnCount: 0, runtimeCount: 0, evictIdle: async () => {}, close: async () => {},
  } as LocalAgentDaemonManager;
  const daemon = new LocalAgentDaemon({ stateDir, configRevision: "old", manager, idleShutdownMs: 60_000,
    workflows: {
      get activeRunCount() { return activeRuns; },
      request: async ({ operation }): Promise<WorkflowReply> => {
        if (operation === "control") { activeRuns = 0; return { ok: true, result: { status: "stopped" } }; }
        return { ok: true, result: { status: "running", runId: "r" } };
      },
      close: async () => { closed = true; },
    },
  });
  t.after(async () => { await daemon.close(); await rm(stateDir, { recursive: true, force: true }); });
  await daemon.start();
  let spawned = false;
  const changedConfig = new LocalAgentClient({ stateDir, configRevision: "new", requestTimeoutMs: 1000,
    spawnDaemon: () => { spawned = true; } });
  const scope = { workspaceId: "w", workspaceRoot: stateDir };
  const running = await changedConfig.workflow({ operation: "get", scope, input: { runId: "r" } });
  assert.equal(running.ok, true, JSON.stringify(running));
  assert.equal(spawned, false);
  const launch = await changedConfig.workflow({ operation: "run", scope, input: { script: "source" } });
  assert.equal(launch.ok, false, "a changed configuration must not replace a daemon with active workflows");
  assert.equal(spawned, false);
  assert.equal(closed, false);
  const resumed = await changedConfig.workflow({ operation: "control", scope,
    input: { runId: "r", action: "resume" } });
  assert.equal(resumed.ok, false, "resume must use a daemon with the current execution configuration");
  assert.equal(activeRuns, 1);
  const restarted = await changedConfig.workflow({ operation: "control", scope,
    input: { runId: "r", action: "restart_agent", stepId: "step-1" } });
  assert.equal(restarted.ok, false, "agent restart must use a daemon with the current execution configuration");
  assert.equal(activeRuns, 1);
  const stopped = await changedConfig.workflow({ operation: "control", scope, input: { runId: "r", action: "stop" } });
  assert.equal(stopped.ok, true);
  assert.equal(activeRuns, 0);
});
