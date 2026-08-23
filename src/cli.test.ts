import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { localAgentDaemonPaths } from "./local-agent-daemon-lifecycle.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { LocalAgentStore } from "./local-agent-store.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "effort: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
    }).id,
    { status: "idle", latestResponse: "Review complete.", providerSessionId: "provider_secret" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const daemonSocket = localAgentDaemonPaths(stateDir).endpoint;
  const daemonRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const daemon = createNetServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        method: string;
        params?: Record<string, unknown>;
      };
      daemonRequests.push(request);
      if (request.method === "agent.start") {
        socket.end(encodeLocalAgentDaemonResponse({
          requestId: request.requestId,
          protocolVersion: 3,
          ok: false,
          error: {
            code: "UNKNOWN_TARGET",
            message: "Unknown subagent profile or provider: missing.",
            retryable: false,
            target: "missing",
          },
        }));
        return;
      }
      const result = request.method === "agent.list"
        ? [current]
        : request.method === "hello"
          ? {
              state: "ready",
              protocolVersion: 3,
              pid: process.pid,
              endpoint: daemonSocket,
              startedAt: "now",
              activeTurns: 0,
              runtimeCount: 0,
              clientConnections: 1,
            }
          : null;
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: 3,
        ok: true,
        result,
      }));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    daemon.once("error", rejectListen);
    daemon.listen(daemonSocket, resolveListen);
  });

  try {
    const { stdout: output } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEVSPACE_CONFIG_DIR: configDir,
        DEVSPACE_ALLOWED_ROOTS: projectRoot,
        DEVSPACE_STATE_DIR: stateDir,
        DEVSPACE_WORKSPACE_ID: "ws_current",
        DEVSPACE_WORKSPACE_ROOT: projectRoot,
        DEVSPACE_SUBAGENTS: "1",
        DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    });

    assert.equal(output.trim(), `${current.id} completed reviewer`);

    const { stdout: jsonOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "ls", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: configDir,
          DEVSPACE_ALLOWED_ROOTS: projectRoot,
          DEVSPACE_STATE_DIR: stateDir,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
          DEVSPACE_SUBAGENTS: "1",
          DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        },
      },
    );
    assert.equal(
      jsonOutput,
      `${JSON.stringify([{ id: current.id, status: "completed", target: "reviewer" }])}\n`,
    );

    const { stdout: directOutput } = await execFileAsync(
      "node",
      ["--import", tsxLoader, cliPath, "agents", "ls"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: configDir,
          DEVSPACE_ALLOWED_ROOTS: stateDir,
          DEVSPACE_STATE_DIR: stateDir,
          DEVSPACE_SUBAGENTS: "1",
          DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          DEVSPACE_WORKSPACE_ID: "",
          DEVSPACE_WORKSPACE_ROOT: stateDir,
        },
      },
    );
    assert.match(directOutput, new RegExp(current.id));
    const directList = [...daemonRequests].reverse().find((request) => request.method === "agent.list");
    assert.deepEqual(directList?.params, { workspaceRoot: realpathSync.native(projectRoot) });

    let commandFailure: unknown;
    try {
      await execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "--json", "inspect"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            DEVSPACE_CONFIG_DIR: configDir,
            DEVSPACE_ALLOWED_ROOTS: projectRoot,
            DEVSPACE_STATE_DIR: stateDir,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
            DEVSPACE_SUBAGENTS: "1",
            DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          },
        },
      );
    } catch (error) {
      commandFailure = error;
    }
    assert.ok(commandFailure, "structured CLI errors should exit non-zero");
    const stdout = (commandFailure as { stdout?: string }).stdout ?? "";
    const payload = JSON.parse(stdout) as {
      error: { code: string; message: string; retryable: boolean; target: string };
    };
    assert.equal(payload.error.code, "UNKNOWN_TARGET");
    assert.equal(payload.error.message, "Unknown subagent profile or provider: missing.");
    assert.equal(payload.error.retryable, false);
    assert.equal(payload.error.target, "missing");

    await assert.rejects(
      execFileAsync(
        "node",
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "agents",
          "run",
          "codex",
          "--model",
          "--unknown",
          "inspect",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            DEVSPACE_CONFIG_DIR: configDir,
            DEVSPACE_ALLOWED_ROOTS: projectRoot,
            DEVSPACE_STATE_DIR: stateDir,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
            DEVSPACE_SUBAGENTS: "1",
            DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          },
        },
      ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? "", /Unknown option: --unknown/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      daemon.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents.enabled, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
