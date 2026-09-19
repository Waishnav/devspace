import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ensureLocalAgentDaemonSecret,
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import type { WorkflowRun } from "./workflow-types.js";

const execFileAsync = promisify(execFile);
// macOS limits the complete Unix socket path to 104 bytes.
const root = await mkdtemp(join(tmpdir(), "ds-wf-"));
const configDir = join(root, "config");
const stateDir = join(root, "state");
const workspaceDirectory = join(root, "project");
await mkdir(workspaceDirectory, { recursive: true });
const workspaceRoot = await realpath(workspaceDirectory);
const env = writeTestDevspaceConfig(configDir, {
  workspaces: { allowedRoots: [workspaceRoot] },
  storage: { stateDir },
});
const paths = localAgentDaemonPaths(stateDir);
ensureLocalAgentDaemonSecret(paths);
const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
const run: WorkflowRun = {
  id: "wfl_test",
  workspaceId: "ws_test",
  workspaceRoot,
  name: "\u001b[31mreview\u001b[0m",
  status: "running",
  writeMode: "read_only",
  concurrency: 2,
  createdAt: "now",
  updatedAt: "now",
  callCount: 0,
};
const daemon = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline)) as {
      requestId: string;
      method: string;
      params: Record<string, unknown>;
    };
    requests.push(request);
    const result = request.method === "hello"
      ? {
          status: {
            state: "ready",
            protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
            pid: process.pid,
            endpoint: paths.endpoint,
            startedAt: "now",
            activeTurns: 0,
            runtimeCount: 0,
            clientConnections: 1,
          },
          configMatches: true,
        }
      : run;
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: true,
      result,
    }));
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    daemon.once("error", reject);
    daemon.listen(paths.endpoint, resolve);
  });
  const workflowFile = join(root, "review.workflow.js");
  await writeFile(workflowFile, "return agent('Review this', { target: 'reviewer' });\n");
  const { stdout } = await execFileAsync("node", [
    "--import", "tsx", "src/cli.ts", "workflow", "run",
    "--file", workflowFile,
    "--args", '{"base":"main"}',
    "--json",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "ws_test",
      DEVSPACE_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  assert.equal(stdout, `${JSON.stringify({ id: run.id, name: run.name, status: run.status })}\n`);
  const submitted = requests.find((request) => request.method === "workflow.run");
  assert.deepEqual(submitted?.params, {
    workspaceId: "ws_test",
    workspaceRoot,
    source: "return agent('Review this', { target: 'reviewer' });\n",
    args: { base: "main" },
  });
  const status = await execFileAsync("node", [
    "--import", "tsx", "src/cli.ts", "workflow", "status", run.id,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "ws_test",
      DEVSPACE_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  assert.equal(status.stdout.includes("\u001b"), false);
  assert.match(status.stdout, /name="\\u001b\[31mreview\\u001b\[0m"/);
} finally {
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
