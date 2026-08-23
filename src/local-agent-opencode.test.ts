import assert from "node:assert/strict";
import {
  opencodeAgentConfig,
  OpencodeLocalAgentDriver,
  opencodeAgentFor,
  opencodePermissionFor,
  type OpencodeClientLike,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";

let sessionNumber = 0;
const createInputs: unknown[] = [];
const promptInputs: unknown[] = [];
const switchInputs: unknown[] = [];
const agentInputs: unknown[] = [];
let healthAvailable = true;
const client = {
  v2: {
    session: {
    async create(input: unknown) {
      createInputs.push(input);
      sessionNumber += 1;
      return { data: { data: { id: `session_${sessionNumber}` } } };
    },
    async prompt(input: unknown) {
      promptInputs.push(input);
      return input;
    },
    async wait() {},
    async messages(input: unknown) {
      const sessionId = (input as { sessionID: string }).sessionID;
      return {
        data: { data: [{
          info: { role: "assistant" },
          parts: [{ type: "text", text: `response:${sessionId}` }],
        }] },
      };
    },
    async get() {
      return { data: { data: { model: { providerID: "anthropic", id: "sonnet" } } } };
    },
    async switchAgent(input: unknown) { agentInputs.push(input); },
    async switchModel(input: unknown) { switchInputs.push(input); },
    },
    health: { async get() {
      if (!healthAvailable) throw new Error("server unavailable");
      return { data: { healthy: true } };
    } },
  },
} as unknown as OpencodeClientLike;
let factoryCalls = 0;
let closeCalls = 0;
const factory: OpencodeFactory = async () => {
  factoryCalls += 1;
  return {
    client,
    server: { close: () => { closeCalls += 1; } },
  };
};
const driver = new OpencodeLocalAgentDriver(factory);
const pool = new LocalAgentRuntimePool();

const first = await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
  }, {
    prompt: "first",
    workspaceRoot: "/tmp/project",
    model: "anthropic/sonnet",
    effort: "high",
  });
const second = await pool.run(driver, {
  agentId: "agt_two",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "second",
  workspaceRoot: "/tmp/project",
});

assert.equal(factoryCalls, 1, "OpenCode agents share one server runtime");
assert.equal(first.isOk(), true);
assert.equal(second.isOk(), true);
if (first.isErr()) throw first.error;
if (second.isErr()) throw second.error;
const firstRecord = first.value;
const secondRecord = second.value;
assert.equal(firstRecord.providerSessionId, "session_1");
assert.equal(secondRecord.providerSessionId, "session_2");
assert.equal(secondRecord.finalResponse, "response:session_2");
assert.deepEqual(createInputs[0], {
  location: { directory: "/tmp/project" },
  agent: "devspace_allowed",
  model: { providerID: "anthropic", id: "sonnet", variant: "high" },
});
assert.deepEqual(promptInputs[0], {
  sessionID: "session_1",
  prompt: { text: "first" },
});

let callbackSessionId: string | undefined;
await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "effort override",
  workspaceRoot: "/tmp/project",
  providerSessionId: firstRecord.providerSessionId ?? undefined,
  effort: "low",
}, {
  onSessionId: (id) => { callbackSessionId = id; },
});
assert.equal(callbackSessionId, firstRecord.providerSessionId);
assert.deepEqual(switchInputs[0], {
  sessionID: "session_1",
  model: { providerID: "anthropic", id: "sonnet", variant: "low" },
});
assert.deepEqual(agentInputs[0], { sessionID: "session_1", agent: "devspace_allowed" });

let readinessActiveCalls = 0;
let readinessWaitCalls = 0;
const readinessRaceClient = {
  v2: {
    session: {
      async create() {
        return { data: { data: { id: "session_readiness" } } };
      },
      async switchAgent() {},
      async prompt() {
        return { data: { data: { id: "prompt_readiness" } } };
      },
      async wait() {
        readinessWaitCalls += 1;
        throw new Error("Session wait is not available yet");
      },
      async active() {
        readinessActiveCalls += 1;
        return {
          data: {
            data: readinessActiveCalls < 3
              ? { session_readiness: { type: "running" } }
              : {},
          },
        };
      },
      async messages() {
        const data = readinessActiveCalls >= 3
          ? [
            { type: "user", id: "prompt_readiness" },
            {
              type: "assistant",
              id: "assistant_readiness",
              time: { created: 1, completed: 2 },
              finish: "stop",
              content: [{ type: "text", id: "part_readiness", text: "ready response" }],
            },
          ]
          : [{ type: "user", id: "prompt_readiness" }];
        return { data: { data } };
      },
    },
    health: { async get() { return { data: { healthy: true } }; } },
  },
} as unknown as OpencodeClientLike;
const readinessPool = new LocalAgentRuntimePool();
const readinessDriver = new OpencodeLocalAgentDriver(async () => ({
  client: readinessRaceClient,
  server: { close: () => undefined },
}));
const readinessResult = await readinessPool.run(readinessDriver, {
  agentId: "agt_readiness",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "readiness", workspaceRoot: "/tmp/project" });
assert.equal(readinessResult.isOk(), true, "OpenCode should wait for the active session to finish");
if (readinessResult.isOk()) {
  assert.equal(readinessResult.value.finalResponse, "ready response");
}
assert.equal(readinessWaitCalls, 0, "OpenCode should not rely on the unavailable wait endpoint");
await readinessPool.close();

const longSessionRequests: Array<{ cursor?: string; order?: string }> = [];
const longSessionClient = {
  v2: {
    session: {
      async create() {
        return { data: { data: { id: "session_long" } } };
      },
      async switchAgent() {},
      async prompt() {
        return { data: { data: { id: "prompt_long" } } };
      },
      async active() {
        return { data: { data: {} } };
      },
      async messages(input: unknown) {
        const request = input as { cursor?: string; order?: string };
        longSessionRequests.push({ cursor: request.cursor, order: request.order });
        if (!request.cursor) {
          return {
            data: {
              data: Array.from({ length: 100 }, (_, index) => ({
                type: "assistant",
                id: `old-assistant-${index}`,
                finish: "stop",
                content: [{ type: "text", text: `old response ${index}` }],
              })),
              cursor: { next: "long-session-next" },
            },
          };
        }
        return {
          data: {
            data: [
              { type: "user", id: "prompt_long" },
              {
                type: "assistant",
                id: "assistant_long",
                finish: "stop",
                content: [{ type: "text", text: "long response" }],
              },
            ],
            cursor: {},
          },
        };
      },
    },
  },
} as unknown as OpencodeClientLike;
const longSessionPool = new LocalAgentRuntimePool();
const longSessionDriver = new OpencodeLocalAgentDriver(async () => ({
  client: longSessionClient,
  server: { close: () => undefined },
}));
const longSessionResult = await longSessionPool.run(longSessionDriver, {
  agentId: "agt_long_session",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "long session", workspaceRoot: "/tmp/project" });
assert.equal(longSessionResult.isOk(), true, "OpenCode should find completions past the first message page");
if (longSessionResult.isOk()) {
  assert.equal(longSessionResult.value.finalResponse, "long response");
}
assert.ok(
  longSessionRequests.some((request) => request.cursor === "long-session-next"),
  "OpenCode should follow the continuation cursor",
);
await longSessionPool.close();

assert.equal(opencodeAgentFor("read_only"), "devspace_read_only");
assert.equal(opencodeAgentFor("full_access"), "devspace_full_access");
assert.deepEqual(opencodePermissionFor("allowed"), {
  read: "allow",
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "allow",
  task: "deny",
  external_directory: "deny",
});
const readOnlyPermissions = opencodePermissionFor("read_only");
assert.equal(typeof readOnlyPermissions === "object" ? readOnlyPermissions.bash : undefined, "deny");
for (const writeMode of ["read_only", "allowed", "full_access"] as const) {
  const config = opencodeAgentConfig(writeMode);
  assert.equal(config.mode, "primary");
  assert.equal(typeof config.permission === "object" ? config.permission.task : undefined, "deny");
}

let promptFailureCount = 0;
const applicationErrorClient = {
  v2: {
    session: {
      async create() { return { data: { data: { id: "session_app_error" } } }; },
      async switchAgent() {},
      async prompt() {
        promptFailureCount += 1;
        if (promptFailureCount === 1) throw new Error("server rejected invalid input");
        return {};
      },
      async wait() {},
      async messages() {
        return { data: { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] }] } };
      },
    },
    health: { async get() { return { data: { healthy: true } }; } },
  },
} as unknown as OpencodeClientLike;
const applicationErrorPool = new LocalAgentRuntimePool();
const applicationErrorDriver = new OpencodeLocalAgentDriver(async () => ({
  client: applicationErrorClient,
  server: { close: () => undefined },
}));
const applicationFailure = await applicationErrorPool.run(applicationErrorDriver, {
  agentId: "agt_app_error",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "bad input", workspaceRoot: "/tmp/project" });
assert.equal(applicationFailure.isErr(), true);
if (applicationFailure.isErr()) {
  assert.equal(applicationFailure.error.code, "PROVIDER_EXECUTION_ERROR");
  assert.equal(applicationFailure.error.retryable, false);
}
assert.equal(applicationErrorPool.size, 1, "ordinary provider errors must not evict a healthy server runtime");
const recoveredApplicationTurn = await applicationErrorPool.run(applicationErrorDriver, {
  agentId: "agt_app_error",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "valid input", workspaceRoot: "/tmp/project" });
assert.equal(recoveredApplicationTurn.isOk(), true);
if (recoveredApplicationTurn.isErr()) throw recoveredApplicationTurn.error;
assert.equal(recoveredApplicationTurn.value.finalResponse, "ok");
await applicationErrorPool.close();

let recoveringFactoryCalls = 0;
const recoveringDriver = new OpencodeLocalAgentDriver(async () => {
  recoveringFactoryCalls += 1;
  healthAvailable = true;
  return { client, server: { close: () => undefined } };
});
const recoveringPool = new LocalAgentRuntimePool();
await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "initial",
  workspaceRoot: "/tmp/project",
});
healthAvailable = false;
const deadRuntime = await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "dead runtime",
  workspaceRoot: "/tmp/project",
});
assert.equal(deadRuntime.isErr(), true);
if (deadRuntime.isErr()) {
  assert.equal(deadRuntime.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(deadRuntime.error.retryable, true);
}
assert.equal(recoveringPool.size, 0, "a failed health check removes the dead runtime immediately");
await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "recreated",
  workspaceRoot: "/tmp/project",
});
assert.equal(recoveringFactoryCalls, 2, "the next turn creates a fresh OpenCode server");
await recoveringPool.close();

await pool.close();
await pool.close();
assert.equal(closeCalls, 1, "shared OpenCode server closes once");
