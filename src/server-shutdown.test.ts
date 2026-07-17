import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownHttpServer } from "./server-shutdown.js";
import { WorkflowOrchestrator } from "./workflows/orchestrator.js";

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
  assert.ok(
    finishHttpClose,
    "HTTP draining must start before application cleanup",
  );
  finishHttpClose();
});

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  true,
  "application cleanup must start while the HTTP server is draining",
);
await drainingShutdown;

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

const httpCloseError = new Error("http close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {},
  ),
  httpCloseError,
);

const workflowState = mkdtempSync(join(tmpdir(), "devspace-shutdown-workflow-"));
try {
  const orchestrator = new WorkflowOrchestrator(workflowState);
  const workflow = orchestrator.submit({
    definition: { version: 1, nodes: [{ key: "agent", type: "agent" }], edges: [] },
    workspace: { workspaceId: "workspace", workspaceRoot: "/tmp/workspace" },
  });
  const waiting = orchestrator.waitForWorkspace(
    workflow.id,
    { workspaceId: "workspace", workspaceRoot: "/tmp/workspace" },
    { timeoutMs: 5_000, pollIntervalMs: 1_000 },
  );
  orchestrator.close();
  const closedSnapshot = await waiting;
  assert.equal(closedSnapshot.id, workflow.id);
  assert.equal(closedSnapshot.status, "queued");
} finally {
  rmSync(workflowState, { recursive: true, force: true });
}
