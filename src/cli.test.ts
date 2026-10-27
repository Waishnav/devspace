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
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

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
  const cliConfigEnv = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [projectRoot] },
    storage: { stateDir },
    subagents: { enabled: true, instructions: "on-demand", providers: [] },
  });
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
      providerInstanceId: "codex",
      driver: "codex",
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
      providerInstanceId: "codex",
      driver: "codex",
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
          protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
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
      const eventsPage = (afterSeq: unknown) => ({
        agentId: current.id,
        turnId: "trn_follow",
        status: afterSeq === 0 ? "running" : "completed",
        events: afterSeq === 0
          ? [
              { type: "turn_started", turnId: "trn_follow", seq: 1, at: "t1" },
              { type: "tool_started", tool: "bash", summary: "git status", turnId: "trn_follow", seq: 2, at: "t2" },
            ]
          : [
              { type: "tool_completed", tool: "bash", summary: "git status", status: "completed", turnId: "trn_follow", seq: 3, at: "t3" },
              { type: "message", text: "Clean tree.", turnId: "trn_follow", seq: 4, at: "t4" },
              { type: "turn_completed", status: "completed", turnId: "trn_follow", seq: 5, at: "t5" },
            ],
      });
      const result = request.method === "agent.events"
        ? eventsPage(request.params?.afterSeq)
        : request.method === "agent.list"
        ? [current]
        : request.method === "agent.get"
          ? current
          : request.method === "agent.wait"
            ? [
                { id: current.id, status: "completed", response: "Review complete." },
                { id: other.id, status: "running", wait: "timeout" },
              ]
        : request.method === "hello"
          ? {
              status: {
                state: "ready",
                protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
                pid: process.pid,
                endpoint: daemonSocket,
                startedAt: "now",
                activeTurns: 0,
                runtimeCount: 0,
                clientConnections: 1,
              },
              configMatches: true,
            }
          : null;
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
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
        ...cliConfigEnv,
        DEVSPACE_WORKSPACE_ID: "ws_current",
        DEVSPACE_WORKSPACE_ROOT: projectRoot,
      },
    });

    assert.equal(
      output.trim(),
      `<agent id="${current.id}" status="completed" target="reviewer"/>`,
    );

    const { stdout: jsonOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "ls", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
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
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "",
          DEVSPACE_WORKSPACE_ROOT: stateDir,
        },
      },
    );
    assert.match(directOutput, new RegExp(current.id));
    const directList = [...daemonRequests].reverse().find((request) => request.method === "agent.list");
    assert.deepEqual(directList?.params, { workspaceRoot: realpathSync.native(projectRoot) });

    const { stdout: showOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "show", current.id],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    );
    assert.equal(
      showOutput,
      `<agent id="${current.id}" status="completed">Review complete.</agent>\n`,
    );
    assert.equal(
      daemonRequests.filter((request) => request.method === "agent.get").length,
      1,
      "show must be an immediate snapshot",
    );

    // A wait that times out exits 4 so scripts can tell it from completion.
    const waitTimeout = await execFileAsync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "agents",
        "wait",
        current.id,
        other.id,
        "--timeout",
        "0",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    ).then(
      () => assert.fail("wait should exit 4 when an agent is still running"),
      (error: { code: number; stdout: string }) => error,
    );
    assert.equal(waitTimeout.code, 4);
    assert.equal(
      waitTimeout.stdout,
      [
        `<agent id="${current.id}" status="completed">Review complete.</agent>`,
        `<agent id="${other.id}" status="running" wait="timeout"/>`,
        "",
      ].join("\n"),
    );
    const waitRequest = daemonRequests.find((request) => request.method === "agent.wait");
    assert.deepEqual(waitRequest?.params, {
      ids: [current.id, other.id],
      scope: { workspaceId: "ws_current", workspaceRoot: realpathSync.native(projectRoot) },
      timeoutMs: 0,
    });

    const { stdout: followOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "events", current.id, "--follow"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    );
    assert.equal(followOutput, [
      '<event seq="1" type="turn_started" turn="trn_follow" at="t1"/>',
      '<event seq="2" type="tool_started" turn="trn_follow" tool="bash">git status</event>',
      '<event seq="3" type="tool_completed" turn="trn_follow" tool="bash" status="completed">git status</event>',
      '<event seq="4" type="message" turn="trn_follow">Clean tree.</event>',
      '<event seq="5" type="turn_completed" turn="trn_follow" status="completed" at="t5"/>',
      "",
    ].join("\n"));
    // Following pins the turn it started on and resumes after the last seen event.
    assert.deepEqual(
      daemonRequests.filter((request) => request.method === "agent.events").map((request) => request.params),
      [
        { id: current.id, scope: { workspaceId: "ws_current", workspaceRoot: realpathSync.native(projectRoot) }, afterSeq: 0 },
        { id: current.id, scope: { workspaceId: "ws_current", workspaceRoot: realpathSync.native(projectRoot) }, turnId: "trn_follow", afterSeq: 2 },
      ],
    );

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
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
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
    assert.equal(payload.error.retryable, false);
    assert.equal(payload.error.target, "missing");

    let xmlCommandFailure: unknown;
    try {
      await execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "inspect"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
          },
        },
      );
    } catch (error) {
      xmlCommandFailure = error;
    }
    assert.ok(xmlCommandFailure, "XML CLI errors should exit non-zero");
    assert.equal(
      (xmlCommandFailure as { stderr?: string }).stderr,
      '<error code="UNKNOWN_TARGET" retryable="false">Unknown subagent profile or provider: missing.</error>\n',
    );

    // --worktree reaches the daemon as a start option; the daemon, not the CLI, creates the worktree.
    await assert.rejects(execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "--worktree", "--branch", "feature/x", "inspect"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    ));
    const worktreeStart = [...daemonRequests].reverse().find((request) => request.method === "agent.start");
    assert.deepEqual(worktreeStart?.params?.worktree, { branch: "feature/x" });
    await assert.rejects(
      execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "codex", "--branch", "feature/x", "inspect"],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...cliConfigEnv } },
      ),
      (error: unknown) => /--branch requires --worktree/.test((error as { stderr?: string }).stderr ?? ""),
    );

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
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
          },
        },
      ),
      (error: unknown) => {
        assert.equal(
          (error as { stderr?: string }).stderr,
          '<error code="AGENT_COMMAND_ERROR" retryable="false">Unknown option: --unknown. Use -- before prompt text that starts with a dash.</error>\n',
        );
        return true;
      },
    );

    for (const helpArgs of [["agents", "run", "--help"], ["agents", "wait", "-h"]]) {
      const help = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...helpArgs], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ...cliConfigEnv },
      });
      assert.match(help.stdout, /^DevSpace agents\n/);
      assert.equal(help.stderr, "");
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      daemon.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  assert.equal(loadConfig(cliConfigEnv).subagents.enabled, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
