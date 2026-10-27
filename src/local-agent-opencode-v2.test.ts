import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOpenCodeV2FinalResponse,
  OpencodeV2Runtime,
  opencodeV2Permissions,
  opencodeV2ServerEnvironment,
  parseOpenCodeV2Model,
  type OpencodeV2ClientLike,
} from "./local-agent-opencode-v2.js";
import { ClientError, type SessionMessageAssistant } from "@opencode/client";
import { OpencodeLocalAgentDriver } from "./local-agent-opencode.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";

const assistant: SessionMessageAssistant = {
  id: "msg_assistant",
  time: { created: 1, completed: 2 },
  type: "assistant",
  agent: "build",
  model: { id: "sonnet", providerID: "anthropic", variant: "high" },
  content: [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "hello" },
    { type: "text", text: " world" },
  ],
  finish: "stop",
};

const failedIdle = {
  id: "msg_idle",
  time: { created: 3 },
  type: "idle",
  outcome: "failed",
  error: { type: "provider.auth", message: "xAI request failed (400): invalid_grant" },
};

function fakeV2Client() {
  const createInputs: unknown[] = [];
  const updateInputs: unknown[] = [];
  const switchModelInputs: unknown[] = [];
  const promptInputs: unknown[] = [];
  const waitInputs: unknown[] = [];
  const messageInputs: unknown[] = [];

  const client = {
    server: {
      async info() { return { version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } }; },
    },
    session: {
      async create(input: unknown) {
        createInputs.push(input);

        return {
          id: "ses_v2",
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/tmp/project" },
        };
      },
      async update(input: unknown) { updateInputs.push(input); },
      async get() {
        return {
          id: "ses_v2",
          projectID: "project",
          model: { id: "sonnet", providerID: "anthropic" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/tmp/project" },
        };
      },
      async switchModel(input: unknown) { switchModelInputs.push(input); },
      async prompt(input: unknown) {
        promptInputs.push(input);

        return { id: "inbox", sessionID: "ses_v2", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" };
      },
      async wait(input: unknown) { waitInputs.push(input); },
    },
    message: {
      async list(input: unknown) {
        messageInputs.push(input);

        return { data: [assistant], cursor: { previous: null, next: null } };
      },
    },
    model: {
      async default() {
        return {
          location: { directory: "/tmp/project" },
          data: {
            id: "default-model",
            modelID: "default-model",
            providerID: "openrouter",
            name: "Default",
            capabilities: {},
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 1, output: 1 },
          },
        };
      },
    },
  } as unknown as OpencodeV2ClientLike;

  return { client, createInputs, updateInputs, switchModelInputs, promptInputs, waitInputs, messageInputs };
}

const firstTurn = {
  prompt: "first",
  workspaceRoot: "/tmp/project",
  writeMode: "read_only",
  model: "anthropic/sonnet",
  effort: "high",
} as const;

test("a new session is created with its permissions and model and returns the final response", async () => {
  const { client, createInputs, updateInputs, switchModelInputs, promptInputs, waitInputs, messageInputs } = fakeV2Client();
  const runtime = new OpencodeV2Runtime(client, { close: () => undefined });
  let sessionId: string | undefined;
  const firstEvents: unknown[] = [];

  const first = await runtime.run(firstTurn, {
    onSessionId: (id) => { sessionId = id; },
    onEvent: (event) => { firstEvents.push(event); },
  });

  assert.equal(first.isOk(), true);

  if (first.isErr()) throw first.error;
  assert.equal(sessionId, "opencode:v2:ses_v2");
  assert.equal(first.value.providerSessionId, "opencode:v2:ses_v2");
  assert.equal(first.value.finalResponse, "hello world");
  assert.deepEqual(firstEvents, [{ type: "message", text: "hello world" }]);
  assert.deepEqual(createInputs[0], {
    location: { directory: "/tmp/project" },
    permissions: opencodeV2Permissions("read_only"),
    model: { providerID: "anthropic", id: "sonnet", variant: "high" },
  });
  assert.equal(updateInputs.length, 0, "new sessions are configured at creation");
  assert.equal(switchModelInputs.length, 0, "new sessions select their model at creation");
  assert.deepEqual(promptInputs[0], { sessionID: "ses_v2", text: "first" });
  assert.deepEqual(waitInputs[0], { sessionID: "ses_v2" });
  assert.deepEqual(messageInputs[0], { sessionID: "ses_v2", limit: 1, order: "desc", type: "assistant" });
  await runtime.close();
});

test("a continued session updates its permissions and switches its model variant", async () => {
  const { client, updateInputs, switchModelInputs } = fakeV2Client();
  const runtime = new OpencodeV2Runtime(client, { close: () => undefined });
  const first = await runtime.run(firstTurn);

  if (first.isErr()) throw first.error;

  const continued = await runtime.run({
    prompt: "continued",
    workspaceRoot: "/tmp/project",
    providerSessionId: "opencode:v2:ses_v2",
    writeMode: "allowed",
    effort: "low",
  });

  assert.equal(continued.isOk(), true);

  if (continued.isErr()) throw continued.error;
  assert.deepEqual(updateInputs[0], {
    sessionID: "ses_v2",
    permissions: opencodeV2Permissions("allowed"),
  });
  assert.deepEqual(switchModelInputs[0], {
    sessionID: "ses_v2",
    model: { id: "sonnet", providerID: "anthropic", variant: "low" },
  });
  await runtime.close();
});

test("a v1 session id is rejected as a different protocol generation", async () => {
  const { client } = fakeV2Client();
  const runtime = new OpencodeV2Runtime(client, { close: () => undefined });

  const wrongGeneration = await runtime.run({
    prompt: "legacy continuation",
    workspaceRoot: "/tmp/project",
    providerSessionId: "ses_v1_legacy",
  });

  assert.equal(wrongGeneration.isErr(), true);

  if (wrongGeneration.isErr()) {
    assert.equal(wrongGeneration.error.code, "PROVIDER_PROTOCOL_ERROR");
    assert.match(wrongGeneration.error.message, /different OpenCode protocol generation/);
  }

  await runtime.close();
});

test("v2 model ids parse with an optional provider and variant", () => {
  assert.deepEqual(parseOpenCodeV2Model("anthropic/sonnet", "high"), {
    providerID: "anthropic",
    id: "sonnet",
    variant: "high",
  });
  assert.deepEqual(parseOpenCodeV2Model("custom-model"), {
    providerID: "opencode",
    id: "custom-model",
  });
  assert.equal(extractOpenCodeV2FinalResponse(assistant), "hello world");
});

test("v2 permissions deny delegation in full access and writes in read-only", () => {
  assert.deepEqual(opencodeV2Permissions("full_access"), [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: "deny" },
  ]);
  assert.deepEqual(opencodeV2Permissions("read_only").slice(-3), [
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ]);
});

test("the v2 server environment replaces ambient passwords with the generated one", () => {
  assert.deepEqual(opencodeV2ServerEnvironment({
    PATH: "/bin",
    OPENCODE_PASSWORD: "ambient-v2",
    OPENCODE_SERVER_PASSWORD: "ambient-v1",
  }, "generated"), {
    PATH: "/bin",
    OPENCODE_PASSWORD: "generated",
  });
});

test("closing a v2 runtime twice closes its server once", async () => {
  const { client } = fakeV2Client();
  let closeCalls = 0;

  const runtime = new OpencodeV2Runtime(client, {
    close: () => { closeCalls += 1; },
  });

  const first = await runtime.run(firstTurn);

  if (first.isErr()) throw first.error;
  await runtime.close();
  await runtime.close();
  assert.equal(closeCalls, 1);
});

test("an OpenCode 2 executable routes the driver to the v2 factory", async (t) => {
  const { client } = fakeV2Client();
  let v1FactoryCalls = 0;
  let v2FactoryCalls = 0;

  const routedDriver = new OpencodeLocalAgentDriver({
    factory: async () => {
      v1FactoryCalls += 1;
      throw new Error("v1 factory must not be selected for OpenCode 2");
    },
    v2Factory: async () => {
      v2FactoryCalls += 1;

      return { client, server: { close: () => undefined } };
    },
    probeRuntime: async () => ({ generation: "v2", version: "2.0.20" }),
  });

  const routedPool = new LocalAgentRuntimePool();
  t.after(() => routedPool.close());

  const routed = await routedPool.run(routedDriver, {
    agentId: "agt_v2",
    providerInstanceId: "opencode",
    provider: "opencode",
    workspaceRoot: "/tmp/project",
  }, {
    prompt: "route through v2",
    workspaceRoot: "/tmp/project",
  });

  assert.equal(routed.isOk(), true);
  assert.equal(v1FactoryCalls, 0);
  assert.equal(v2FactoryCalls, 1);
});

// A runtime created after OpenCode is upgraded must follow the installed executable, not a stale probe.
test("a runtime created after an upgrade follows the installed executable", async () => {
  let installedGeneration: "v1" | "v2" = "v1";
  const calls = { v1: 0, v2: 0 };

  const upgradingDriver = new OpencodeLocalAgentDriver({
    factory: async () => {
      calls.v1 += 1;
      throw new Error("stop after routing");
    },
    v2Factory: async () => {
      calls.v2 += 1;
      throw new Error("stop after routing");
    },
    probeRuntime: async () => ({ generation: installedGeneration, version: "x.y.z" }),
  });

  const upgradeContext = {
    agentId: "agt_upgrade",
    providerInstanceId: "opencode",
    provider: "opencode",
    workspaceRoot: "/tmp/project",
  } as const;

  await upgradingDriver.createRuntime(upgradeContext);
  installedGeneration = "v2";
  await upgradingDriver.createRuntime(upgradeContext);
  assert.deepEqual(calls, { v1: 1, v2: 1 });
});

// A turn that fails before any assistant output surfaces the provider's error, not a protocol error.
test("a turn that fails before assistant output surfaces the provider error", async () => {
  const { client } = fakeV2Client();

  const failedClient = {
    ...client,
    message: {
      async list(input: { type?: string }) {
        return { data: input.type === "assistant" ? [] : [failedIdle], cursor: { previous: null, next: null } };
      },
    },
  } as unknown as OpencodeV2ClientLike;

  const failedRuntime = new OpencodeV2Runtime(failedClient, { close: () => undefined });
  const failedRun = await failedRuntime.run({ prompt: "auth fails", workspaceRoot: "/tmp/project" });
  assert.equal(failedRun.isErr(), true);

  if (failedRun.isErr()) {
    assert.equal(failedRun.error.code, "PROVIDER_EXECUTION_ERROR");
    assert.match(failedRun.error.message, /invalid_grant/);
  }

  await failedRuntime.close();
});

// A continued turn that fails before output must not return the previous turn's response.
test("a continued turn that fails before output does not return the previous response", async () => {
  const { client } = fakeV2Client();

  const staleClient = {
    ...client,
    session: {
      ...client.session,
      async prompt() {
        return { id: "inbox", sessionID: "ses_v2", time: { created: 5 }, type: "user", payload: { text: "x" }, delivery: "queue" };
      },
    },
    message: {
      async list(input: { type?: string }) {
        return { data: input.type === "assistant" ? [assistant] : [failedIdle], cursor: { previous: null, next: null } };
      },
    },
  } as unknown as OpencodeV2ClientLike;

  const staleRuntime = new OpencodeV2Runtime(staleClient, { close: () => undefined });

  const staleRun = await staleRuntime.run({
    prompt: "continued but failing",
    workspaceRoot: "/tmp/project",
    providerSessionId: "opencode:v2:ses_v2",
  });

  assert.equal(staleRun.isErr(), true);

  if (staleRun.isErr()) assert.match(staleRun.error.message, /invalid_grant/);
  await staleRuntime.close();
});

// Stop ends the turn only once OpenCode confirms the interrupt; a failed interrupt leaves it running.
const interruptRun = async (interrupt: () => Promise<unknown>) => {
  const { client } = fakeV2Client();

  const interruptClient = {
    ...client,
    session: {
      ...client.session,
      interrupt,
      async wait(_input: unknown, options?: { signal?: AbortSignal }) {
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
    },
  } as unknown as OpencodeV2ClientLike;

  const interruptRuntime = new OpencodeV2Runtime(interruptClient, { close: () => undefined }, 100);
  const stop = new AbortController();
  const run = interruptRuntime.run({ prompt: "stop me", workspaceRoot: "/tmp/project", signal: stop.signal });
  setTimeout(() => stop.abort(), 10);
  const result = await run;
  await interruptRuntime.close();

  return result.isErr() ? result.error.code : "ok";
};

test("stop cancels the turn once OpenCode confirms the interrupt", async () => {
  assert.equal(await interruptRun(async () => ({ interrupted: true })), "PROVIDER_CANCELLED");
});

test("a failed interrupt is a protocol error rather than a cancellation", async () => {
  assert.equal(await interruptRun(async () => { throw new Error("interrupt failed"); }), "PROVIDER_PROTOCOL_ERROR");
});

// A dead server surfaces as a Transport ClientError; the runtime must report itself unavailable.
test("a dead server makes the runtime report itself unavailable", async () => {
  const { client } = fakeV2Client();

  const deadRuntime = new OpencodeV2Runtime({
    ...client,
    server: {
      async info() {
        throw new ClientError("Transport", { cause: new TypeError("fetch failed") });
      },
    },
  } as unknown as OpencodeV2ClientLike, { close: () => undefined });

  const deadRun = await deadRuntime.run({ prompt: "server gone", workspaceRoot: "/tmp/project" });
  assert.equal(deadRun.isErr() ? deadRun.error.code : "ok", "PROVIDER_UNAVAILABLE");
  assert.equal(deadRuntime.isAlive(), false);
  await deadRuntime.close();
});
