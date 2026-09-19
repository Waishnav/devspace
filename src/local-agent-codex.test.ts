import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexAppServerRuntime,
  CodexLocalAgentDriver,
  codexCommandEnvironment,
  parseCodexVersion,
  resolveCodexCommand,
  sandboxFor,
} from "./local-agent-codex.js";
import { toAgentErrorPayload } from "./local-agent-errors.js";

const cachedContext = { agentId: "agt_test", provider: "codex" as const, workspaceRoot: "/tmp/project" };

assert.equal(parseCodexVersion("codex-cli 0.9.1"), "0.9.1");
assert.equal(sandboxFor("read_only"), "read-only");
assert.equal(sandboxFor("allowed"), "workspace-write");
assert.equal(sandboxFor("full_access"), "danger-full-access");
assert.equal(
  codexCommandEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test", PATH: "/tmp/bin" }).CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  undefined,
);

if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-app-server-test-"));
  const badBin = join(root, "bad-bin");
  const goodBin = join(root, "good-bin");
  await mkdir(badBin);
  await mkdir(goodBin);
  const badCandidate = join(badBin, "codex");
  const goodCandidate = join(goodBin, "codex");
  await writeFile(badCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(goodCandidate, "#!/bin/sh\necho 'codex-cli 9.8.7'\n", { mode: 0o700 });
  await chmod(badCandidate, 0o700);
  await chmod(goodCandidate, 0o700);
  assert.deepEqual(
    resolveCodexCommand({ PATH: `${badBin}:${goodBin}` }),
    { executable: goodCandidate, version: "9.8.7" },
    "command resolution must skip candidates whose version probe exits non-zero",
  );

  const command = join(root, "fake-codex");
  await writeFile(command, `#!/usr/bin/env node
import readline from "node:readline";
let turn = 0;
let pendingTurn;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    output({ id: message.id, result: { thread: { id: message.params.threadId || "thread_new" } } });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    output({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn_" + turn;
    output({ id: message.id, result: { turn: { id: turnId } } });
    if (message.params.input[0].text === "cancel" || message.params.input[0].text === "cancel-fail") {
      pendingTurn = { threadId: message.params.threadId, turnId, failInterrupt: message.params.input[0].text === "cancel-fail" };
      return;
    }
    setImmediate(() => {
      if (message.params.input[0].text === "fail") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "failed", error: { message: "fake failure" } } } });
        return;
      }
      if (message.params.input[0].text === "empty") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [] } } });
        return;
      }
      if (message.params.input[0].text === "notLoaded") {
        const item = { type: "agentMessage", text: "CODEXOK" };
        output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [], itemsView: "notLoaded" } } });
        return;
      }
      const item = { type: "agentMessage", text: message.params.input[0].text === "policy"
        ? JSON.stringify(message.params.sandboxPolicy)
        : "fake response " + turn };
      output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
      output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    if (pendingTurn?.failInterrupt) {
      output({ id: message.id, error: { code: -32000, message: "fake interrupt failure" } });
      pendingTurn = undefined;
      return;
    }
    output({ id: message.id, result: {} });
    if (pendingTurn) {
      output({ method: "turn/completed", params: { threadId: pendingTurn.threadId, turn: { id: pendingTurn.turnId, status: "interrupted", items: [] } } });
      pendingTurn = undefined;
    }
  }
});
`, { mode: 0o700 });
  await chmod(command, 0o700);

  const interruptErrors: unknown[] = [];
  const runtime = new CodexAppServerRuntime({ command, env: process.env, onInterruptError: (error) => { interruptErrors.push(error); } });
  try {
    await runtime.initialize();
    let callbackSessionId: string | undefined;
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: "/tmp/project",
      writeMode: "read_only",
      model: "gpt-5.4",
      effort: "high",
    }, { onSessionId: (id) => { callbackSessionId = id; } });
    assert.equal(firstResult.isOk(), true);
    if (firstResult.isErr()) throw firstResult.error;
    const first = firstResult.value;
    const resumedResult = await runtime.run({
      prompt: "resumed",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(resumedResult.isOk(), true);
    if (resumedResult.isErr()) throw resumedResult.error;
    const resumed = resumedResult.value;
    assert.equal(first.providerSessionId, "thread_new");
    assert.equal(callbackSessionId, "thread_new");
    assert.equal(first.finalResponse, "fake response 1");
    assert.equal(resumed.providerSessionId, "thread_new");
    assert.equal(resumed.finalResponse, "fake response 2");
    const failed = await runtime.run({
      prompt: "fail",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(failed.isErr(), true);
    if (failed.isErr()) {
      assert.equal(failed.error.code, "PROVIDER_EXECUTION_ERROR");
      assert.equal(failed.error.provider, "codex");
      assert.equal(failed.error.retryable, false);
    }
    const protocolFailure = await runtime.run({
      prompt: "empty",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(protocolFailure.isErr(), true);
    if (protocolFailure.isErr()) {
      assert.equal(protocolFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(protocolFailure.error.provider, "codex");
      assert.equal(protocolFailure.error.retryable, false);
      assert.ok(protocolFailure.error.cause, "provider protocol cause remains available internally");
      assert.equal("cause" in toAgentErrorPayload(protocolFailure.error), false);
    }
    const notLoaded = await runtime.run({
      prompt: "notLoaded",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(notLoaded.isOk(), true, "empty turn.items must fall back to item/completed stream items");
    if (notLoaded.isErr()) throw notLoaded.error;
    assert.equal(notLoaded.value.finalResponse, "CODEXOK");
    const policy = await runtime.run({
      prompt: "policy",
      workspaceRoot: "/tmp/project",
      writeMode: "allowed",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(policy.isOk(), true);
    if (policy.isErr()) throw policy.error;
    assert.deepEqual(JSON.parse(policy.value.finalResponse), { type: "workspaceWrite", networkAccess: true });
    const controller = new AbortController();
    const cancelled = runtime.run({
      prompt: "cancel",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult.isErr(), true);
    if (cancelledResult.isErr()) assert.equal(cancelledResult.error.code, "PROVIDER_CANCELLED");
    assert.equal(runtime.isAlive(), true, "turn cancellation keeps the shared Codex runtime alive");
    const failedInterruptController = new AbortController();
    const failedInterrupt = runtime.run({
      prompt: "cancel-fail",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
      signal: failedInterruptController.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    failedInterruptController.abort();
    const failedInterruptResult = await failedInterrupt;
    assert.equal(failedInterruptResult.isErr(), true);
    if (failedInterruptResult.isErr()) assert.equal(failedInterruptResult.error.code, "PROVIDER_EXECUTION_ERROR");
    assert.equal(interruptErrors.length, 1);
    const afterCancellation = await runtime.run({
      prompt: "after cancellation",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(afterCancellation.isOk(), true, "the shared runtime accepts a later turn");
    await runtime.releaseSession("thread_new");
  } finally {
    await runtime.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

const unavailable = await new CodexLocalAgentDriver({}, () => undefined).createRuntime(cachedContext);
assert.equal(unavailable.isErr(), true);
if (unavailable.isErr()) {
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, false);
}
