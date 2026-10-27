import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HeadTailBuffer, ProcessOwner, ProcessSessionManager } from "./process-sessions.js";

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

test("drained output is returned once", () => {
  const smallBuffer = new HeadTailBuffer(100);
  smallBuffer.append("hello\n");
  assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
  assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });
});

test("output beyond the buffer limit keeps its head and tail", () => {
  const headTail = new HeadTailBuffer(10);
  headTail.append("start-middle-end");
  const headTailResult = headTail.drain(1_000);
  assert.equal(headTailResult.truncated, true);
  assert.match(headTailResult.output, /^start/);
  assert.match(headTailResult.output, /e-end$/);
  assert.match(headTailResult.output, /characters omitted/);
});

test("output beyond the response limit is truncated to its head and tail", () => {
  const responseLimited = new HeadTailBuffer(100);
  responseLimited.append("abcdef".repeat(20));
  const responseLimitedResult = responseLimited.drain(40);
  assert.equal(responseLimitedResult.truncated, true);
  assert.match(responseLimitedResult.output, /^abc/);
  assert.match(responseLimitedResult.output, /def$/);
});

test("truncation never splits a Unicode character", () => {
  const unicodeBuffer = new HeadTailBuffer(4);
  unicodeBuffer.append("a🙂b🙂c");
  const unicodeResult = unicodeBuffer.drain(1_000);
  assert.equal(unicodeResult.truncated, true);
  assert.match(unicodeResult.output, /^a🙂/);
  assert.match(unicodeResult.output, /🙂c$/);
});

test("a command that finishes within the yield time returns no session", async (t) => {
  const manager = createManager(t);

  const foreground = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log('foreground')"`,
    yieldTimeMs: 2_000,
  });

  assert.equal(foreground.running, false);
  assert.equal(foreground.exitCode, 0);
  assert.match(foreground.output, /foreground/);
  assert.equal(foreground.sessionId, undefined);
});

test("commands run with a non-interactive environment and workspace identity", async (t) => {
  const manager = createManager(t);

  const environment = await manager.start({
    workspaceId: "workspace-a",
    workspaceRoot: "/tmp/devspace-workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
    yieldTimeMs: 2_000,
  });

  assert.equal(environment.running, false);
  assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);
});

test("a background session is only readable from its own workspace and reports completion", async (t) => {
  const manager = createManager(t);

  const background = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
    yieldTimeMs: 5,
  });

  assert.equal(background.running, true);
  assert.ok(background.sessionId);
  assert.equal(typeof background.sessionId, "number");

  await assert.rejects(
    manager.write({
      workspaceId: "workspace-b",
      sessionId: background.sessionId,
      yieldTimeMs: 1,
    }),
    /does not belong to workspace/,
  );

  const completed = await manager.write({
    workspaceId: "workspace-a",
    sessionId: background.sessionId,
    yieldTimeMs: 2_000,
  });

  assert.equal(completed.running, false);
  assert.equal(completed.exitCode, 0);
  assert.match(completed.output, /finished/);
});

test("input written to an interactive session reaches stdin", async (t) => {
  const manager = createManager(t);

  const interactive = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });

  assert.equal(interactive.running, true);
  assert.ok(interactive.sessionId);
  assert.equal(typeof interactive.sessionId, "number");

  const inputResult = await manager.write({
    workspaceId: "workspace-a",
    sessionId: interactive.sessionId,
    chars: "hello\n",
    yieldTimeMs: 2_000,
  });

  assert.equal(inputResult.running, false);
  assert.match(inputResult.output, /input:hello/);
});

test("writing input without a yield time waits for the response", async (t) => {
  const manager = createManager(t);

  const defaultInteractive = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
    yieldTimeMs: 5,
  });

  assert.equal(defaultInteractive.running, true);
  assert.ok(defaultInteractive.sessionId);

  const defaultInputResult = await manager.write({
    workspaceId: "workspace-a",
    sessionId: defaultInteractive.sessionId,
    chars: "hello\n",
  });

  assert.equal(defaultInputResult.running, false);
  assert.match(defaultInputResult.output, /default-input:hello/);
});

test("input reaches an interactive session that is producing output", async (t) => {
  const manager = createManager(t);

  const noisyInteractive = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 100,
  });

  assert.equal(noisyInteractive.running, true);
  assert.ok(noisyInteractive.sessionId);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const noisyInputResult = await manager.write({
    workspaceId: "workspace-a",
    sessionId: noisyInteractive.sessionId,
    chars: "hello\n",
    yieldTimeMs: 2_000,
  });

  assert.equal(noisyInputResult.running, false);
  assert.match(noisyInputResult.output, /input:hello/);
});

test("Ctrl-C interrupts a running session", async (t) => {
  const manager = createManager(t);

  const interruptible = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
    yieldTimeMs: 100,
  });

  assert.equal(interruptible.running, true);
  assert.ok(interruptible.sessionId);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const interrupted = await manager.write({
    workspaceId: "workspace-a",
    sessionId: interruptible.sessionId,
    chars: "\u0003",
    yieldTimeMs: 2_000,
  });

  assert.equal(interrupted.running, false);

  if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");
});

test("output beyond the token limit is reported as truncated", async (t) => {
  const manager = createManager(t);

  let buffered = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
    yieldTimeMs: 50,
    maxOutputTokens: 100,
  });

  if (!buffered.outputTruncated && buffered.sessionId) {
    buffered = await manager.write({
      workspaceId: "workspace-a",
      sessionId: buffered.sessionId,
      yieldTimeMs: 2_000,
      maxOutputTokens: 100,
    });
  }

  assert.equal(buffered.outputTruncated, true);

  if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);
});

test("a Windows pseudo-terminal session runs the command", { skip: process.platform !== "win32" }, async (t) => {
  const manager = createManager(t);

  const pty = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: "echo pty-ok",
    tty: true,
    yieldTimeMs: 10_000,
  });

  assert.equal(pty.running, false);
  assert.match(pty.output, /pty-ok/);
});

test("a pseudo-terminal session reports resized columns", { skip: process.platform === "win32" }, async (t) => {
  const manager = createManager(t);

  const pty = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
    tty: true,
    columns: 80,
    rows: 24,
    yieldTimeMs: 10,
  });

  assert.equal(pty.running, true);
  assert.ok(pty.sessionId);

  const resizedPty = await manager.write({
    workspaceId: "workspace-a",
    sessionId: pty.sessionId,
    columns: 120,
    rows: 30,
    yieldTimeMs: 2_000,
  });

  assert.equal(resizedPty.running, false);
  assert.match(resizedPty.output, /columns:120/);
});

// A descendant that leaves the process group keeps the output pipe open after
// the group is killed; termination must stay bounded and report it.
test("termination stays bounded when a descendant escapes the process group", { skip: process.platform !== "linux" }, async (t) => {
  const escapeManager = new ProcessSessionManager();
  const owner = new ProcessOwner();
  const dir = mkdtempSync(join(tmpdir(), "devspace-escape-"));
  const pidFile = join(dir, "escaped.pid");
  t.after(() => {
    // Only signal a real positive PID: kill(0) would signal this test's own process group.
    const escapedPid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10) : NaN;

    if (Number.isSafeInteger(escapedPid) && escapedPid > 0) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    escapeManager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  await escapeManager.runOwned(owner, () => escapeManager.start({
    workspaceId: "workspace-escape",
    command: `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & sleep 30`,
    cwd: dir,
    yieldTimeMs: 300,
  }));
  const startedAt = Date.now();
  const unconfirmed = await owner.terminate();
  assert.equal(unconfirmed, 1, "the escaped descendant's open pipe is reported");
  assert.ok(Date.now() - startedAt < 10_000, "termination stays bounded");
});

function createManager(t: TestContext): ProcessSessionManager {
  const manager = new ProcessSessionManager({
    maxBufferCharacters: 1_024,
    completedSessionTtlMs: 1_000,
  });

  t.after(() => manager.shutdown());

  return manager;
}
