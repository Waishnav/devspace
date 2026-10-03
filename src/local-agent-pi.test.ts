import assert from "node:assert/strict";
import {
  PiLocalAgentDriver,
  type PiRpcFactory,
  type PiRpcRuntimeConnection,
} from "./local-agent-pi.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakePiRpcConnection implements PiRpcRuntimeConnection {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  sessionFile = "/sessions/one.jsonl";
  lastPrompt = "";
  alive = true;
  cleanupCount = 0;

  async request(record: Record<string, unknown>): Promise<unknown> {
    this.requests.push(record);
    switch (record.type) {
      case "new_session":
        this.sessionFile = `/sessions/${this.requests.length}.jsonl`;
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

  async send(_record: Record<string, unknown>): Promise<void> {}

  async nextEvent(): Promise<Record<string, unknown> | undefined> {
    return this.events.shift();
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
  }
}

const contexts: LocalAgentRuntimeContext[] = [];
const connections: FakePiRpcConnection[] = [];
let factoryEnv: NodeJS.ProcessEnv | undefined;
let cleanupCount = 0;
const factory: PiRpcFactory = async (context, env) => {
  contexts.push(context);
  factoryEnv = env;
  const connection = new FakePiRpcConnection();
  connections.push(connection);
  return {
    connection,
    cleanup: async () => { cleanupCount += 1; },
  };
};

const driver = new PiLocalAgentDriver(factory, { HARNESS_ENV: "pi" });
const pool = new LocalAgentRuntimePool();
const context: LocalAgentRuntimeContext = {
  agentId: "agt_pi",
  providerInstanceId: "pi",
  provider: "pi",
  workspaceRoot: "/tmp/project",
  writeMode: "read_only",
};
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
assert.equal(factoryEnv?.HARNESS_ENV, "pi");
assert.equal(first.isOk(), true);
if (first.isErr()) throw first.error;
assert.match(first.value.providerSessionId ?? "", /^\/sessions\/\d+\.jsonl$/);
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
assert.equal(cleanupCount, 2, "idle eviction closes external Pi processes and sandbox wrappers");

await pool.run(driver, { ...context, providerSessionId: first.value.providerSessionId ?? undefined }, {
  prompt: "resumed",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.value.providerSessionId ?? undefined,
  writeMode: "read_only",
});
assert.equal(contexts.length, 3, "cold continuation starts a new Pi RPC process");
assert.ok(connections[2]?.requests.some((request) => request.type === "switch_session"));
await pool.close();

const missingModel = new FakePiRpcConnection();
missingModel.request = async function(record: Record<string, unknown>): Promise<unknown> {
  this.requests.push(record);
  if (record.type === "get_available_models") return { models: [] };
  if (record.type === "new_session") return { cancelled: false };
  if (record.type === "get_state") return { sessionFile: "/sessions/missing.jsonl" };
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
