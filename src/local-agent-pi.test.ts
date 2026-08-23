import assert from "node:assert/strict";
import { basename } from "node:path";
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import {
  PiLocalAgentDriver,
  piToolsForWriteMode,
  type PiSessionFactory,
  type PiSessionLike,
} from "./local-agent-pi.js";
import { createPiSandboxConfig } from "./local-agent-pi-sandbox.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakePiSession implements PiSessionLike {
  readonly sessionId = "pi_session_1";
  readonly messages: any[] = [];
  readonly modelRegistry = { find: () => ({ id: "model" }) } as unknown as PiSessionLike["modelRegistry"];
  private readonly listeners = new Set<AgentSessionEventListener>();
  disposeCount = 0;
  model?: unknown;
  effort?: unknown;
  activeTools: string[] = [];
  toolHistory: string[][] = [];

  async prompt(text: string): Promise<void> {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: `response:${text}` }],
    };
    this.messages.push(message);
    for (const listener of this.listeners) listener({ type: "agent_end" } as AgentSessionEvent);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setModel(model: any): Promise<void> {
    this.model = model;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
    this.toolHistory.push([...toolNames]);
  }

  setThinkingLevel(level: any): void {
    this.effort = level;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

const contexts: LocalAgentRuntimeContext[] = [];
const sessions: FakePiSession[] = [];
const factory: PiSessionFactory = async (context) => {
  contexts.push(context);
  const session = new FakePiSession();
  sessions.push(session);
  return session;
};
const driver = new PiLocalAgentDriver(factory);
const pool = new LocalAgentRuntimePool();
const context: LocalAgentRuntimeContext = {
  agentId: "agt_pi",
  provider: "pi",
  workspaceRoot: "/tmp/project",
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
const second = await pool.run(driver, context, {
  prompt: "second",
  workspaceRoot: "/tmp/project",
  writeMode: "allowed",
});
await pool.run(driver, context, {
  prompt: "third",
  workspaceRoot: "/tmp/project",
  writeMode: "full_access",
});
await pool.run(driver, context, {
  prompt: "fourth",
  workspaceRoot: "/tmp/project",
  writeMode: "read_only",
});
assert.equal(contexts.length, 1, "one warm Pi session serves successive turns");
assert.equal(first.isOk(), true);
assert.equal(second.isOk(), true);
if (first.isErr()) throw first.error;
if (second.isErr()) throw second.error;
assert.equal(first.value.providerSessionId, "pi_session_1");
assert.equal(second.value.finalResponse, "response:second");
assert.deepEqual(sessions[0]?.model, { id: "model" });
assert.equal(sessions[0]?.effort, "high");
assert.deepEqual(sessionIds, ["pi_session_1"]);
assert.deepEqual(piToolsForWriteMode("allowed"), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
assert.ok(
  createPiSandboxConfig().filesystem.denyRead.some((path) => basename(path) === ".ssh"),
  "sandbox config includes the protected-home read rule; enforcement is covered by local-agent-pi-sandbox.test.ts",
);
assert.deepEqual(sessions[0]?.activeTools, ["read", "grep", "find", "ls"]);
assert.deepEqual(sessions[0]?.toolHistory, [
  ["read", "grep", "find", "ls"],
  ["read", "grep", "find", "ls", "edit", "write", "bash"],
  ["read", "grep", "find", "ls", "edit", "write", "bash"],
  ["read", "grep", "find", "ls"],
]);

await pool.run(driver, { ...context, providerSessionId: "pi_session_1" }, {
  prompt: "fifth",
  workspaceRoot: "/tmp/project",
  providerSessionId: "pi_session_1",
  writeMode: "allowed",
});
assert.deepEqual(sessions[0]?.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);

await pool.evictIdle(Date.now() + 10 * 60_000);
assert.equal(sessions[0]?.disposeCount, 1, "idle eviction disposes the in-process session");

await pool.run(driver, { ...context, providerSessionId: "pi_session_1" }, {
  prompt: "resumed",
  workspaceRoot: "/tmp/project",
  providerSessionId: "pi_session_1",
});
assert.equal(contexts.length, 2, "cold continuation creates a new AgentSession");
assert.equal(contexts[1]?.providerSessionId, "pi_session_1");
assert.deepEqual(sessions[1]?.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
await pool.close();

const missingModelSession = new FakePiSession();
Object.defineProperty(missingModelSession, "modelRegistry", { value: { find: () => undefined } });
const missingModelDriver = new PiLocalAgentDriver(async () => missingModelSession);
const missingModelRuntime = await missingModelDriver.createRuntime(context);
assert.equal(missingModelRuntime.isOk(), true);
if (missingModelRuntime.isErr()) throw missingModelRuntime.error;
const missingModel = await missingModelRuntime.value.run({
  prompt: "inspect",
  workspaceRoot: "/tmp/project",
  model: "provider/missing-model",
});
assert.equal(missingModel.isErr(), true);
if (missingModel.isErr()) {
  assert.equal(missingModel.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(missingModel.error.retryable, false);
  assert.match(missingModel.error.message, /provider\/missing-model/);
}
await missingModelRuntime.value.close();
