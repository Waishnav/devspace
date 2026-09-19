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
const active = new Map();
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
    active.set(turnId, { threadId: message.params.threadId, prompt: message.params.input[0].text });
    if (message.params.input[0].text === "ignore interrupt") {
      output({ method: "item/started", params: { threadId: message.params.threadId, turnId, item: { type: "commandExecution" } } });
      return;
    }
    if (message.params.input[0].text === "hold") return;
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
        : message.params.input[0].text === "structured"
          ? JSON.stringify({ ok: true })
        : "fake response " + turn };
      output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
      output({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId, tokenUsage: { last: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 1, cacheWriteInputTokens: 2, reasoningOutputTokens: 4 } } } });
      output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
      active.delete(turnId);
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    output({ id: message.id, result: {} });
    const current = active.get(message.params.turnId);
    const threadId = current?.threadId;
    if (current?.prompt === "ignore interrupt") {
      const item = { type: "agentMessage", text: "late success" };
      output({ method: "turn/completed", params: { threadId, turn: { id: message.params.turnId, status: "completed", items: [item] } } });
      active.delete(message.params.turnId);
      return;
    }
    output({ method: "turn/completed", params: { threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
    active.delete(message.params.turnId);
  }
});
`, { mode: 0o700 });
  await chmod(command, 0o700);

  const runtime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await runtime.initialize();
    const preAborted = new AbortController();
    preAborted.abort();
    const rejectedBeforeTurn = await runtime.run({
      prompt: "cancelled-before-turn",
      workspaceRoot: "/tmp/project",
    }, undefined, { signal: preAborted.signal });
    assert.equal(rejectedBeforeTurn.isErr(), true);
    if (rejectedBeforeTurn.isErr()) assert.equal(rejectedBeforeTurn.error.code, "PROVIDER_CANCELLED");
    let callbackSessionId: string | undefined;
    const usageUpdates: unknown[] = [];
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: "/tmp/project",
      writeMode: "read_only",
      model: "gpt-5.4",
      effort: "high",
      attemptId: "attempt_codex_1",
    }, {
      onSessionId: (id) => { callbackSessionId = id; },
      onUsage: (usage) => { usageUpdates.push(usage); },
    });
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
    assert.deepEqual(usageUpdates.at(-1), {
      attemptId: "attempt_codex_1",
      sequence: 2,
      inputTokens: 3,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
      final: true,
    });
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
    const correctionPolicy = await runtime.run({
      prompt: "policy",
      workspaceRoot: "/tmp/project",
      writeMode: "full_access",
      toolPolicy: "read_only",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(correctionPolicy.isOk(), true);
    if (correctionPolicy.isErr()) throw correctionPolicy.error;
    assert.deepEqual(JSON.parse(correctionPolicy.value.finalResponse), { type: "readOnly" });
    const structured = await runtime.run({
      prompt: "structured",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
      outputSchema: { type: "object" },
    });
    assert.equal(structured.isOk(), true);
    if (structured.isErr()) throw structured.error;
    assert.deepEqual(structured.value.structuredOutput, { ok: true });

    const controller = new AbortController();
    const held = runtime.run({
      prompt: "hold",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    }, undefined, { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    const cancelled = await held;
    assert.equal(cancelled.isErr(), true);
    if (cancelled.isErr()) assert.equal(cancelled.error.code, "PROVIDER_CANCELLED");
    const ignoredController = new AbortController();
    let ignoredTurnStarted!: () => void;
    const ignoredTurnStart = new Promise<void>((resolve) => { ignoredTurnStarted = resolve; });
    const ignored = runtime.run({
      prompt: "ignore interrupt",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    }, { onProgress: () => { ignoredTurnStarted(); } }, { signal: ignoredController.signal });
    await ignoredTurnStart;
    ignoredController.abort();
    const lateSuccess = await ignored;
    if (lateSuccess.isErr()) throw lateSuccess.error;
    assert.equal(lateSuccess.isOk(), true, "an abort signal alone must not overwrite the provider's terminal result");
    assert.equal(lateSuccess.value.finalResponse, "late success");
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
