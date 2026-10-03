import assert from "node:assert/strict";
import {
  extractOpenCodeV2FinalResponse,
  OpencodeV2Runtime,
  opencodeV2Permissions,
  opencodeV2ServerEnvironment,
  parseOpenCodeV2Model,
  type OpencodeV2ClientLike,
} from "./local-agent-opencode-v2.js";
import type { SessionMessageAssistant } from "@opencode/client";
import { OpencodeLocalAgentDriver } from "./local-agent-opencode.js";
import { OpenCodeRuntimeProbe } from "./local-agent-opencode-version.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";

const createInputs: unknown[] = [];
const updateInputs: unknown[] = [];
const switchModelInputs: unknown[] = [];
const promptInputs: unknown[] = [];
const waitInputs: unknown[] = [];
const messageInputs: unknown[] = [];
let closeCalls = 0;

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

const runtime = new OpencodeV2Runtime(client, {
  close: () => { closeCalls += 1; },
});
let sessionId: string | undefined;
const first = await runtime.run({
  prompt: "first",
  workspaceRoot: "/tmp/project",
  writeMode: "read_only",
  model: "anthropic/sonnet",
  effort: "high",
}, {
  onSessionId: (id) => { sessionId = id; },
});
assert.equal(first.isOk(), true);
if (first.isErr()) throw first.error;
assert.equal(sessionId, "opencode:v2:ses_v2");
assert.equal(first.value.providerSessionId, "opencode:v2:ses_v2");
assert.equal(first.value.finalResponse, "hello world");
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
assert.deepEqual(opencodeV2ServerEnvironment({
  PATH: "/bin",
  OPENCODE_PASSWORD: "ambient-v2",
  OPENCODE_SERVER_PASSWORD: "ambient-v1",
}, "generated"), {
  PATH: "/bin",
  OPENCODE_PASSWORD: "generated",
});

await runtime.close();
await runtime.close();
assert.equal(closeCalls, 1);

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
  runtimeProbe: new OpenCodeRuntimeProbe(async () => ({ generation: "v2", version: "2.0.20" })),
});
const routedPool = new LocalAgentRuntimePool();
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
await routedPool.close();
