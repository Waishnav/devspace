import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AcpLocalAgentDriver,
  AcpRuntime,
  acpCommandArgs,
  resolveAcpCommand,
  selectAcpPermissionOption,
} from "./local-agent-acp.js";
import { GrokPromptCompletionRegistry } from "./local-agent-grok.js";

const requests: Array<{ method: string; params?: unknown }> = [];
const queues = new Map<string, { values: unknown[] }>();
const connection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        const sessionId = "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return {
          sessionId,
          configOptions: [
            { type: "select", category: "model", id: "model", options: [{ value: "model-a" }] },
            { type: "select", category: "thought_level", id: "effort", options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/resume") {
        const sessionId = input?.sessionId ?? "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return { sessionId };
      }
      if (method === "session/prompt") {
        const queue = queues.get(input?.sessionId ?? "");
        queue?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};

const sessionIds: string[] = [];
const runtime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: true, additionalDirectories: true },
  queues,
}, connection);

const firstResult = await runtime.run({
  prompt: "first",
  workspaceRoot: "/tmp/project",
  model: "model-a",
  effort: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
assert.equal(firstResult.isOk(), true);
if (firstResult.isErr()) throw firstResult.error;
const first = firstResult.value;
const warmResult = await runtime.run({
  prompt: "warm",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  effort: "high",
  writeMode: "full_access",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
assert.equal(warmResult.isOk(), true);
if (warmResult.isErr()) throw warmResult.error;
const warm = warmResult.value;

assert.equal(first.providerSessionId, "cursor_session_1");
assert.equal(warm.finalResponse, "ACP response");
assert.deepEqual(sessionIds, ["cursor_session_1", "cursor_session_1"]);
assert.equal(requests.filter(({ method }) => method === "session/new").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 0);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
assert.equal(
  Object.hasOwn(requests.find(({ method }) => method === "session/new")?.params as object, "additionalDirectories"),
  false,
);

await runtime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);
assert.equal(runtime.isAlive(), true);

const resumedRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: false },
  queues,
}, connection);
const resumedPersistedResult = await resumedRuntime.run({
  prompt: "resumed with persisted config",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  effort: "high",
});
assert.equal(resumedPersistedResult.isOk(), true);
if (resumedPersistedResult.isErr()) throw resumedPersistedResult.error;
const resumedPersisted = resumedPersistedResult.value;
assert.equal(resumedPersisted.finalResponse, "ACP response");
assert.equal(
  requests.filter(({ method }) => method === "session/set_config_option").length,
  4,
  "cold resume must not require config metadata just to preserve prior model/effort state",
);
const resumeFailure = await resumedRuntime.run({
  prompt: "resumed",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-that-is-not-advertised-after-resume",
  modelOverrideRequested: true,
});
assert.equal(resumeFailure.isErr(), true);
if (resumeFailure.isErr()) assert.equal(resumeFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
await resumedRuntime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);

const closeOnlyRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: false, close: true },
}, connection);
await closeOnlyRuntime.releaseSession("close_only_session");
assert.equal(
  requests.filter(({ method, params }) => method === "session/close" && (params as { sessionId?: string })?.sessionId === "close_only_session").length,
  1,
  "session close support must not depend on resume support",
);
await closeOnlyRuntime.close();

assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed"),
  { optionId: "allow" },
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "read_only"),
  { optionId: "reject" },
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed", "copilot"),
  undefined,
  "sandboxed Copilot permission requests must fail closed",
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], undefined),
  undefined,
  "permission requests for unknown ACP sessions must fail closed",
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "full_access", "copilot"),
  { optionId: "allow" },
);

const overlapQueues = new Map<string, { values: unknown[] }>();
let releaseOverlappingPrompt!: () => void;
let markPromptEntered!: () => void;
const overlappingPrompt = new Promise<void>((resolvePrompt) => { releaseOverlappingPrompt = resolvePrompt; });
const promptEntered = new Promise<void>((resolveEntered) => { markPromptEntered = resolveEntered; });
const overlapConnection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        overlapQueues.set("overlap_session", { values: [] });
        return { sessionId: "overlap_session" };
      }
      if (method === "session/prompt") {
        markPromptEntered();
        await overlappingPrompt;
        overlapQueues.get(input?.sessionId ?? "")?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "overlap response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const overlapRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  queues: overlapQueues,
}, overlapConnection);
let overlapSessionId: string | undefined;
const firstOverlappingTurn = overlapRuntime.run({
  prompt: "first overlapping turn",
  workspaceRoot: "/tmp/project",
}, { onSessionId: (sessionId) => { overlapSessionId = sessionId; } });
await promptEntered;
await assert.rejects(
  overlapRuntime.run({
    prompt: "second overlapping turn",
    workspaceRoot: "/tmp/project",
    providerSessionId: overlapSessionId,
  }),
  /already has an active turn/,
);
releaseOverlappingPrompt();
const completedOverlappingTurn = await firstOverlappingTurn;
assert.equal(completedOverlappingTurn.isOk(), true);
if (completedOverlappingTurn.isErr()) throw completedOverlappingTurn.error;
assert.equal(completedOverlappingTurn.value.finalResponse, "overlap response");
await overlapRuntime.close();

let resolverCalls = 0;
const cachedDriver = new AcpLocalAgentDriver("cursor", {}, () => {
  resolverCalls += 1;
  return "/usr/local/bin/cursor-agent";
});
const cachedContext = {
  agentId: "agt_acp",
  provider: "cursor" as const,
  workspaceRoot: "/tmp/project",
  writeMode: "allowed" as const,
};
const resolvedProject = resolve("/tmp/project");
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
for (const writeMode of ["read_only", "allowed", "full_access"] as const) {
  assert.notEqual(
    cachedDriver.runtimeKey({ ...cachedContext, writeMode, workspaceRoot: "/tmp/other-project" }),
    cachedDriver.runtimeKey({ ...cachedContext, writeMode }),
    `${writeMode} ACP runtimes are scoped to one workspace root`,
  );
}
assert.equal(resolverCalls, 1, "ACP executable identity is resolved once per driver lifecycle");
assert.deepEqual(acpCommandArgs("cursor", cachedContext), [
  "acp", "--sandbox", "enabled", "--workspace", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("grok", {
  ...cachedContext,
  provider: "grok",
  effort: "low",
}), ["agent", "--reasoning-effort", "low", "stdio"]);
assert.deepEqual(acpCommandArgs("grok", {
  ...cachedContext,
  provider: "grok",
  effort: "low",
}, { GROK_AGENT_PROFILE: " /tmp/grok-coding-only.md " }), [
  "agent", "--agent-profile", "/tmp/grok-coding-only.md", "--reasoning-effort", "low", "stdio",
]);
assert.deepEqual(acpCommandArgs("copilot", cachedContext), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "read_only" }), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject, "--mode", "plan",
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "full_access" }), [
  "--acp", "--no-sandbox", "--allow-all", "-C", resolvedProject,
]);

const missingCommandDriver = new AcpLocalAgentDriver(
  "cursor",
  process.env,
  () => join(tmpdir(), "devspace-definitely-missing-acp-command"),
);
const missingCommand = await missingCommandDriver.createRuntime(cachedContext);
assert.equal(missingCommand.isErr(), true);
if (missingCommand.isErr()) {
  assert.equal(missingCommand.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(missingCommand.error.retryable, true);
}

if (process.platform === "win32") {
  const shimRoot = await mkdtemp(join(tmpdir(), "devspace-acp-shim-test-"));
  const binDir = join(shimRoot, "node_modules", ".bin");
  const marker = join(shimRoot, "args.json");
  const recorder = join(binDir, "record-args.cjs");
  const command = join(binDir, "copilot.cmd");
  const workspaceRoot = join(shimRoot, "workspace & harmless");
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await writeFile(command, `@ECHO OFF\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    const shimDriver = new AcpLocalAgentDriver("copilot", process.env, () => command);
    const shimStartup = await shimDriver.createRuntime({ ...cachedContext, provider: "copilot", workspaceRoot });
    assert.equal(shimStartup.isErr(), true);
    if (shimStartup.isErr()) assert.equal(shimStartup.error.code, "PROVIDER_PROTOCOL_ERROR");
    const forwarded = JSON.parse(await readFile(marker, "utf8")) as string[];
    assert.equal(
      forwarded.filter((argument) => argument === resolve(workspaceRoot)).length,
      2,
      "Windows command shims must receive workspace paths containing shell metacharacters as literal arguments",
    );
  } finally {
    await rm(shimRoot, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const commandRoot = await mkdtemp(join(tmpdir(), "devspace-acp-command-test-"));
  const candidate = join(commandRoot, "cursor-agent");
  const marker = join(commandRoot, "executed");
  try {
    await writeFile(candidate, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
    await chmod(candidate, 0o700);
    assert.equal(resolveAcpCommand("cursor", { PATH: commandRoot }), candidate);
    assert.equal(existsSync(marker), false, "ACP command discovery must not execute PATH candidates");
  } finally {
    await rm(commandRoot, { recursive: true, force: true });
  }
}

const grokRequests: Array<{ method: string; params?: unknown }> = [];
const grokQueues = new Map<string, { values: unknown[] }>();
const grokCompletionRegistry = new GrokPromptCompletionRegistry();
const grokConnection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      grokRequests.push({ method, params });
      const input = params as { sessionId?: string; _meta?: { promptId?: string } } | undefined;
      if (method === "session/new") {
        grokQueues.set("grok_session_1", { values: [] });
        return {
          sessionId: "grok_session_1",
          models: {
            currentModelId: "grok-4.5",
            availableModels: [{
              modelId: "grok-4.5",
              _meta: { reasoningEfforts: [{ id: "low", value: "low" }] },
            }],
          },
        };
      }
      if (method === "session/set_model") return {};
      if (method === "session/prompt") {
        grokQueues.get(input?.sessionId ?? "")?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Grok response" },
          },
        });
        setImmediate(() => grokCompletionRegistry.resolve({
          sessionId: input?.sessionId ?? "",
          promptId: input?._meta?.promptId,
          stopReason: "end_turn",
        }));
        return new Promise(() => undefined);
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const grokRuntime = new AcpRuntime({
  provider: "grok",
  command: "grok",
  args: ["agent", "--reasoning-effort", "low", "stdio"],
  env: {},
  capabilities: { resume: true, close: true },
  queues: grokQueues,
  grokCompletionRegistry,
  promptCompletionTimeoutMs: 100,
}, grokConnection);
const grokResult = await grokRuntime.run({
  prompt: "which model are you",
  workspaceRoot: "/tmp/project",
  model: "grok-4.5",
  effort: "low",
});
assert.equal(grokResult.isOk(), true);
if (grokResult.isErr()) throw grokResult.error;
assert.equal(grokResult.value.finalResponse, "Grok response");
assert.deepEqual(
  grokRequests.filter(({ method }) => method === "session/set_model").map(({ params }) => params),
  [{ sessionId: "grok_session_1", modelId: "grok-4.5", _meta: { reasoningEffort: "low" } }],
);
assert.equal(grokCompletionRegistry.size, 0);
await grokRuntime.close();

const grokConfigurationConnection = {
  agent: {
    async request(method: string): Promise<unknown> {
      if (method === "session/new") {
        return {
          sessionId: "grok_configuration_session",
          models: {
            currentModelId: "grok-4.5",
            availableModels: [{
              modelId: "grok-4.5",
              _meta: { reasoningEfforts: [{ id: "low", value: "low" }] },
            }],
          },
        };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const grokConfigurationRuntime = new AcpRuntime({
  provider: "grok",
  command: "grok",
  args: ["agent", "stdio"],
  env: {},
}, grokConfigurationConnection);
const invalidGrokModel = await grokConfigurationRuntime.run({
  prompt: "invalid model",
  workspaceRoot: "/tmp/project",
  model: "grok-unknown",
});
assert.equal(invalidGrokModel.isErr(), true);
if (invalidGrokModel.isErr()) {
  assert.equal(invalidGrokModel.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(invalidGrokModel.error.retryable, false);
  assert.match(invalidGrokModel.error.message, /Available models: grok-4\.5/);
}
const invalidGrokEffort = await grokConfigurationRuntime.run({
  prompt: "invalid effort",
  workspaceRoot: "/tmp/project",
  effort: "high",
});
assert.equal(invalidGrokEffort.isErr(), true);
if (invalidGrokEffort.isErr()) {
  assert.equal(invalidGrokEffort.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(invalidGrokEffort.error.retryable, false);
  assert.match(invalidGrokEffort.error.message, /Available efforts: low/);
}
await grokConfigurationRuntime.close();

await resumedRuntime.close();
await resumedRuntime.close();
assert.equal(resumedRuntime.isAlive(), false);
