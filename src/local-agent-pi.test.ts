import type { JsonObject, WireInput } from "./json-value.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  PiLocalAgentDriver,
  type PiRpcFactory,
  type PiRpcRuntimeConnection,
  piLaunchArgs,
} from "./local-agent-pi.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

const sessionDirectory = mkdtempSync(join(tmpdir(), "devspace-pi-test-"));
let sessionCount = 0;

// Pi session references are real files; resuming validates that.
function sessionFile(name = `session-${++sessionCount}`): string {
  const path = join(sessionDirectory, `${name}.jsonl`);
  writeFileSync(path, "");

  return path;
}

class FakePiRpcConnection implements PiRpcRuntimeConnection {
  readonly requests: Array<JsonObject> = [];
  readonly events: Array<JsonObject> = [];
  sessionFile = sessionFile("one");
  lastPrompt = "";
  alive = true;
  cleanupCount = 0;

  async request(record: JsonObject): Promise<WireInput> {
    this.requests.push(record);

    switch (record.type) {
      case "new_session":
        this.sessionFile = sessionFile();

        return { cancelled: false };
      case "switch_session":
        this.sessionFile = String(record.sessionPath);

        return { cancelled: false };
      case "get_state":
        return {
          sessionFile: this.sessionFile,
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
        };
      case "get_available_models":
        return { models: [{ provider: "provider", id: "model" }] };
      case "set_model":
      case "set_thinking_level":
      case "abort":
        return undefined;
      case "prompt":
        this.lastPrompt = String(record.message);

        if (this.lastPrompt === "use tools") {
          this.events.push(
            { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
            { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: {}, isError: false },
            { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Two files." }] } },
          );
        }

        this.events.push(
          { type: "agent_start" },
          { type: "agent_end" },
          { type: "agent_settled" },
        );

        return undefined;
      case "get_last_assistant_text":
        return { text: `response:${this.lastPrompt}` };
      default:
        throw new Error(`unexpected request: ${String(record.type)}`);
    }
  }

  async send(_record: JsonObject): Promise<void> {}

  async nextEvent(timeoutMs = 0): Promise<JsonObject | undefined> {
    const event = this.events.shift();

    if (event) return event;
    // Like the real connection, an empty queue waits instead of spinning on microtasks.
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(timeoutMs, 5)));

    return undefined;
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
  }
}

function piPoolFixture(t: TestContext) {
  const contexts: LocalAgentRuntimeContext[] = [];
  const connections: FakePiRpcConnection[] = [];
  // SAFETY: The surrounding checks or construction already match this type.
  const state = { factoryEnv: undefined as NodeJS.ProcessEnv | undefined, cleanupCount: 0 };

  const factory: PiRpcFactory = async (context, env) => {
    contexts.push(context);
    state.factoryEnv = env;
    const connection = new FakePiRpcConnection();
    connections.push(connection);

    return {
      connection,
      cleanup: async () => { state.cleanupCount += 1; },
    };
  };

  const driver = new PiLocalAgentDriver(factory, { HARNESS_ENV: "pi" });
  const pool = new LocalAgentRuntimePool();
  t.after(() => pool.close());

  return { contexts, connections, state, driver, pool };
}

const context: LocalAgentRuntimeContext = {
  agentId: "agt_pi",
  providerInstanceId: "pi",
  provider: "pi",
  workspaceRoot: "/tmp/project",
  writeMode: "read_only",
};

test("a first Pi turn applies the model and effort and reports its session", async (t) => {
  const { connections, state, driver, pool } = piPoolFixture(t);
  const sessionIds: string[] = [];

  const first = await pool.run(driver, context, {
    prompt: "first",
    workspaceRoot: "/tmp/project",
    model: "provider/model",
    effort: "high",
    writeMode: "read_only",
  }, {
    onSessionId: (sessionId) => { sessionIds.push(sessionId); },
  });

  assert.equal(state.factoryEnv?.HARNESS_ENV, "pi");
  assert.equal(first.isOk(), true);

  if (first.isErr()) throw first.error;
  assert.match(first.value.providerSessionId ?? "", /session-\d+\.jsonl$/);
  assert.equal(first.value.finalResponse, "response:first");
  assert.deepEqual(sessionIds, [first.value.providerSessionId]);
  assert.deepEqual(
    connections[0]?.requests.filter((request) => request.type === "set_model")[0],
    { type: "set_model", provider: "provider", modelId: "model" },
  );
  assert.deepEqual(
    connections[0]?.requests.filter((request) => request.type === "set_thinking_level")[0],
    { type: "set_thinking_level", level: "high" },
  );
  assert.ok(first.value.items.some((event: any) => event.type === "agent_end"));
  assert.ok(first.value.items.some((event: any) => event.type === "agent_settled"));
});

test("the runtime pool reuses, replaces, evicts, and cold-resumes Pi processes", async (t) => {
  const { contexts, connections, state, driver, pool } = piPoolFixture(t);

  const first = await pool.run(driver, context, {
    prompt: "first",
    workspaceRoot: "/tmp/project",
    model: "provider/model",
    effort: "high",
    writeMode: "read_only",
  });

  if (first.isErr()) throw first.error;

  const second = await pool.run(driver, context, {
    prompt: "second",
    workspaceRoot: "/tmp/project",
    providerSessionId: first.value.providerSessionId ?? undefined,
    writeMode: "read_only",
  });

  assert.equal(second.isOk(), true);
  assert.equal(contexts.length, 1, "same agent and write mode reuse one Pi RPC process");

  await pool.run(driver, { ...context, writeMode: "allowed" }, {
    prompt: "allowed",
    workspaceRoot: "/tmp/project",
    providerSessionId: first.value.providerSessionId ?? undefined,
    writeMode: "allowed",
  });
  assert.equal(contexts.length, 2, "changing Pi write mode creates a process with the matching fixed permission policy");
  assert.ok(connections[1]?.requests.some((request) => request.type === "switch_session"));

  await pool.evictIdle(Date.now() + 10 * 60_000);
  assert.equal(state.cleanupCount, 2, "idle eviction closes external Pi processes and sandbox wrappers");

  await pool.run(driver, { ...context, providerSessionId: first.value.providerSessionId ?? undefined }, {
    prompt: "resumed",
    workspaceRoot: "/tmp/project",
    providerSessionId: first.value.providerSessionId ?? undefined,
    writeMode: "read_only",
  });
  assert.equal(contexts.length, 3, "cold continuation starts a new Pi RPC process");
  assert.ok(connections[2]?.requests.some((request) => request.type === "switch_session"));
});

test("a model Pi does not offer is a protocol error naming the model", async () => {
  const missingModel = new FakePiRpcConnection();
  missingModel.request = async function(record: JsonObject): Promise<WireInput> {
    this.requests.push(record);

    if (record.type === "get_available_models") return { models: [] };

    if (record.type === "new_session") return { cancelled: false };

    if (record.type === "get_state") return { sessionFile: sessionFile("missing") };
    throw new Error(`unexpected request: ${String(record.type)}`);
  };

  const missingModelDriver = new PiLocalAgentDriver(async () => ({ connection: missingModel }));
  const missingRuntime = await missingModelDriver.createRuntime(context);
  assert.equal(missingRuntime.isOk(), true);

  if (missingRuntime.isErr()) throw missingRuntime.error;

  const missingResult = await missingRuntime.value.run({
    prompt: "inspect",
    workspaceRoot: "/tmp/project",
    model: "missing-model",
  });

  assert.equal(missingResult.isErr(), true);

  if (missingResult.isErr()) {
    assert.equal(missingResult.error.code, "PROVIDER_PROTOCOL_ERROR");
    assert.match(missingResult.error.message, /missing-model/);
  }

  await missingRuntime.value.close();
});

// A bare session id from before Pi ran over RPC must fail instead of opening an empty session.
test("a bare pre-RPC session id fails instead of opening an empty session", async () => {
  const legacyConnection = new FakePiRpcConnection();
  const legacyDriver = new PiLocalAgentDriver(async () => ({ connection: legacyConnection }));
  const legacyRuntime = await legacyDriver.createRuntime(context);

  if (legacyRuntime.isErr()) throw legacyRuntime.error;

  const legacyResult = await legacyRuntime.value.run({
    prompt: "continue",
    workspaceRoot: "/tmp/project",
    providerSessionId: "019f-legacy-session-id",
  });

  assert.equal(legacyResult.isErr(), true);

  if (legacyResult.isErr()) assert.match(legacyResult.error.message, /Start a new agent/);
  assert.equal(legacyConnection.requests.some((request) => request.type === "switch_session"), false);
  await legacyRuntime.value.close();
});

// An exact model id wins over provider/model parsing (gateway providers use ids containing "/").
test("an exact model id wins over provider/model parsing", async () => {
  const gatewayConnection = new FakePiRpcConnection();
  gatewayConnection.request = async function(record: JsonObject): Promise<WireInput> {
    if (record.type === "get_available_models") {
      this.requests.push(record);

      return { models: [{ provider: "openrouter", id: "openai/gpt-4o" }] };
    }

    return FakePiRpcConnection.prototype.request.call(this, record);
  };

  const gatewayRuntime = await new PiLocalAgentDriver(async () => ({ connection: gatewayConnection })).createRuntime(context);

  if (gatewayRuntime.isErr()) throw gatewayRuntime.error;

  const gatewayResult = await gatewayRuntime.value.run({
    prompt: "inspect",
    workspaceRoot: "/tmp/project",
    model: "openai/gpt-4o",
  });

  assert.equal(gatewayResult.isOk(), true);
  assert.deepEqual(
    gatewayConnection.requests.find((request) => request.type === "set_model"),
    { type: "set_model", provider: "openrouter", modelId: "openai/gpt-4o" },
  );
  await gatewayRuntime.value.close();
});

// Stop: Pi is aborted, a Pi that never settles is discarded, and stale events never reach the next turn.
test("stopping aborts Pi and discards a Pi that does not settle", async () => {
  const stalledConnection = new FakePiRpcConnection();
  stalledConnection.request = async function(record: JsonObject): Promise<WireInput> {
    if (record.type === "prompt") {
      this.requests.push(record);
      this.events.push({ type: "agent_start" });

      return undefined;
    }

    return FakePiRpcConnection.prototype.request.call(this, record);
  };

  const stalledRuntime = await new PiLocalAgentDriver(async () => ({ connection: stalledConnection })).createRuntime(context);

  if (stalledRuntime.isErr()) throw stalledRuntime.error;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);

  const stalledResult = await stalledRuntime.value.run({
    prompt: "stop me",
    workspaceRoot: "/tmp/project",
    signal: stop.signal,
  });

  assert.equal(stalledResult.isErr(), true);

  if (stalledResult.isErr()) assert.equal(stalledResult.error.code, "PROVIDER_CANCELLED");
  assert.ok(stalledConnection.requests.some((request) => request.type === "abort"));
  assert.equal(stalledRuntime.value.isAlive(), false, "a Pi that does not settle after abort is discarded");
});

test("an already-aborted signal never sends the prompt", async () => {
  const preAbortConnection = new FakePiRpcConnection();
  const preAbortRuntime = await new PiLocalAgentDriver(async () => ({ connection: preAbortConnection })).createRuntime(context);

  if (preAbortRuntime.isErr()) throw preAbortRuntime.error;
  const alreadyStopped = new AbortController();
  alreadyStopped.abort();

  const preAbortResult = await preAbortRuntime.value.run({
    prompt: "never starts",
    workspaceRoot: "/tmp/project",
    signal: alreadyStopped.signal,
  });

  assert.equal(preAbortResult.isErr(), true);
  assert.equal(preAbortConnection.requests.some((request) => request.type === "prompt"), false);
  await preAbortRuntime.value.close();
});

test("leftover events from an earlier turn do not settle the next one", async () => {
  const staleConnection = new FakePiRpcConnection();
  staleConnection.events.push({ type: "agent_start" }, { type: "agent_settled" });
  const staleRuntime = await new PiLocalAgentDriver(async () => ({ connection: staleConnection })).createRuntime(context);

  if (staleRuntime.isErr()) throw staleRuntime.error;
  const staleResult = await staleRuntime.value.run({ prompt: "fresh", workspaceRoot: "/tmp/project" });

  if (staleResult.isErr()) throw staleResult.error;
  assert.ok(staleResult.value.items.some((event: any) => event.type === "agent_end"), "leftover events from an earlier turn do not settle this one");
  await staleRuntime.value.close();
});

// Pi RPC tool and message frames map onto DevSpace activity events.
test("Pi RPC tool and message frames map onto DevSpace activity events", async () => {
  const streamingConnection = new FakePiRpcConnection();
  const streamingDriver = new PiLocalAgentDriver(async () => ({ connection: streamingConnection }));
  const streamingRuntime = await streamingDriver.createRuntime(context);

  if (streamingRuntime.isErr()) throw streamingRuntime.error;
  const piEvents: WireInput[] = [];

  const streamed = await streamingRuntime.value.run({ prompt: "use tools", workspaceRoot: "/tmp/project" }, {
    onEvent: (event) => { piEvents.push(event); },
  });

  if (streamed.isErr()) throw streamed.error;
  assert.equal(streamingDriver.capabilities.turns.streaming, true);
  assert.deepEqual(piEvents, [
    { type: "tool_started", tool: "bash", summary: "ls" },
    { type: "tool_completed", tool: "bash", summary: "ls", status: "completed" },
    { type: "message", text: "Two files." },
  ]);
  await streamingRuntime.value.close();
});

test("a missing Pi command is unavailable", async () => {
  const missingCommand = await new PiLocalAgentDriver(undefined, { PATH: "", PI_COMMAND: "/missing/pi" }).createRuntime(context);
  assert.equal(missingCommand.isErr() && missingCommand.error.code, "PROVIDER_UNAVAILABLE");
});

test("sandboxed Pi runs disable user extensions but keep the DevSpace sandbox", () => {
  assert.deepEqual(piLaunchArgs(["cli.js"], "read_only", "/tmp/sandbox.ts"), [
    "cli.js", "--mode", "rpc", "--approve",
    "--no-extensions", "--extension", "/tmp/sandbox.ts",
    "--tools", "read,grep,find,ls",
  ]);
  assert.deepEqual(piLaunchArgs([], "allowed", "/tmp/sandbox.ts"), [
    "--mode", "rpc", "--approve",
    "--no-extensions", "--extension", "/tmp/sandbox.ts",
    "--tools", "read,grep,find,ls,edit,write,bash",
  ]);
  // full_access has no sandbox, so the user's extensions stay enabled.
  assert.deepEqual(piLaunchArgs([], "full_access", undefined), ["--mode", "rpc", "--approve"]);
  assert.throws(() => piLaunchArgs([], "allowed", undefined), /sandbox extension/);
});
