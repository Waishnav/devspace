import assert from "node:assert/strict";
import {
  ClaudeLocalAgentDriver,
  claudeAuthoritySettings,
  type ClaudeQueryLike,
  type ClaudeQueryMessage,
  type ClaudeUserMessage,
} from "./local-agent-claude.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { subagentsConfigSchema } from "./local-agent-config.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";

class FakeClaudeQuery implements ClaudeQueryLike, AsyncIterator<ClaudeQueryMessage> {
  private readonly iterator: AsyncIterator<ClaudeUserMessage>;
  closeCount = 0;
  model?: string;
  permissionModes: string[] = [];
  flagSettings: Settings[] = [];

  constructor(prompt: AsyncIterable<ClaudeUserMessage>) {
    this.iterator = prompt[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeQueryMessage> {
    return this;
  }

  async next(): Promise<IteratorResult<ClaudeQueryMessage>> {
    const next = await this.iterator.next();

    if (next.done) return { done: true, value: undefined };

    return {
      done: false,
      value: {
        type: "result",
        session_id: "claude_session_1",
        result: `response:${next.value.message.content}`,
      },
    };
  }

  close(): void {
    this.closeCount += 1;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
  }

  async applyFlagSettings(settings: Settings): Promise<void> {
    this.flagSettings.push({ ...settings });
  }

  async setModel(model?: string): Promise<void> {
    this.model = model;
  }
}

const context: LocalAgentRuntimeContext = {
  agentId: "agt_claude",
  provider: "claude",
  workspaceRoot: "/tmp/project",
  model: "sonnet",
  effort: "high",
  writeMode: "read_only",
};

let factoryCalls = 0;

let lastOptions: Options | undefined;

let query: FakeClaudeQuery | undefined;

const driver = new ClaudeLocalAgentDriver(({ prompt, options }) => {
  factoryCalls += 1;
  lastOptions = options;
  query = new FakeClaudeQuery(prompt);

  return query;
}, { PATH: "/usr/bin" });

assert.equal(driver.runtimeKey(context), "claude:agt_claude:restricted");

assert.equal(
  driver.runtimeKey({ ...context, writeMode: "allowed" }),
  "claude:agt_claude:restricted",
  "restricted Claude modes can share one query because per-turn settings are dynamic",
);

assert.equal(
  driver.runtimeKey({ ...context, writeMode: "full_access" }),
  "claude:agt_claude:full_access",
  "full access uses a query initialized with the explicit dangerous-permission opt-in",
);

const runtimeResult = await driver.createRuntime(context);

assert.equal(runtimeResult.isOk(), true);

if (runtimeResult.isErr()) throw runtimeResult.error;

const runtime = runtimeResult.value;

const sessionIds: string[] = [];

const firstResult = await runtime.run({
  prompt: "first",
  workspaceRoot: "/tmp/project",
  model: "sonnet",
  effort: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});

assert.equal(firstResult.isOk(), true);

if (firstResult.isErr()) throw firstResult.error;

const first = firstResult.value;

const secondResult = await runtime.run({
  prompt: "second",
  workspaceRoot: "/tmp/project",
  effort: "low",
  writeMode: "allowed",
});

assert.equal(secondResult.isOk(), true);

if (secondResult.isErr()) throw secondResult.error;

const second = secondResult.value;

const third = await runtime.run({
  prompt: "third",
  workspaceRoot: "/tmp/project",
  effort: "high",
  writeMode: "full_access",
});

assert.equal(third.isOk(), true);

assert.equal(factoryCalls, 1, "successive turns reuse one Claude query");

assert.equal(first.providerSessionId, "claude_session_1");

assert.equal(second.finalResponse, "response:second");

assert.equal(query?.model, "sonnet");

assert.equal(lastOptions?.resume, undefined);

assert.equal(lastOptions?.permissionMode, "dontAsk");

assert.equal(lastOptions?.allowDangerouslySkipPermissions, undefined);

assert.deepEqual(lastOptions?.allowedTools, ["Read(/**)", "Edit(/**)", "Bash"]);

assert.equal(lastOptions?.pathToClaudeCodeExecutable, undefined);

assert.ok(lastOptions?.sandbox);

const initialSandbox = lastOptions.sandbox;

assert.equal(initialSandbox.enabled, true);

assert.equal(initialSandbox.failIfUnavailable, true);

assert.equal(initialSandbox.autoAllowBashIfSandboxed, true);

assert.equal(initialSandbox.allowUnsandboxedCommands, false);

assert.deepEqual(initialSandbox.filesystem?.allowWrite, []);

assert.deepEqual(initialSandbox.filesystem?.denyWrite, ["/tmp/project"]);

const allowedSettings = claudeAuthoritySettings("/tmp/project", "allowed");

assert.deepEqual(allowedSettings.permissions?.deny, []);

assert.deepEqual(allowedSettings.sandbox?.filesystem, {
  allowWrite: ["/tmp/project"],
  denyWrite: [],
});

const readOnlySettings = claudeAuthoritySettings("/tmp/project", "read_only");

assert.ok(readOnlySettings.permissions?.deny?.includes("Bash"));

assert.ok(readOnlySettings.permissions?.deny?.includes("Edit"));

assert.deepEqual(
  readOnlySettings.sandbox?.filesystem?.allowWrite,
  [],
);

const fullSettings = claudeAuthoritySettings("/tmp/project", "full_access");

assert.deepEqual(fullSettings.sandbox, {
  enabled: false,
  allowUnsandboxedCommands: true,
});

assert.deepEqual(sessionIds, ["claude_session_1"]);

assert.deepEqual(query?.permissionModes, ["dontAsk", "dontAsk", "bypassPermissions"]);

assert.equal(query?.flagSettings.length, 3);

assert.ok(query);

assert.equal(query.flagSettings[0]?.alwaysThinkingEnabled, true);

assert.equal(query.flagSettings[0]?.effortLevel, "high");

assert.equal(
  query.flagSettings[0]?.permissions?.defaultMode,
  "dontAsk",
);

assert.equal(query.flagSettings[1]?.effortLevel, "low");

assert.equal(
  query.flagSettings[1]?.permissions?.deny?.includes("Edit"),
  false,
);

assert.equal(
  query.flagSettings[2]?.permissions?.defaultMode,
  "bypassPermissions",
);

await runtime.close();

await runtime.close();

assert.equal(query?.closeCount, 1);

const coldRuntime = await driver.createRuntime({ ...context, providerSessionId: "cold_session" });

assert.equal(coldRuntime.isOk(), true);

assert.equal(lastOptions?.resume, "cold_session");

const customCommandDriver = new ClaudeLocalAgentDriver(({ prompt, options }) => {
  lastOptions = options;

  return new FakeClaudeQuery(prompt);
}, { CLAUDE_COMMAND: "/opt/claude" });

const customCommandRuntime = await customCommandDriver.createRuntime(context);

assert.equal(customCommandRuntime.isOk(), true);

assert.equal(lastOptions?.pathToClaudeCodeExecutable, "/opt/claude");

if (customCommandRuntime.isOk()) await customCommandRuntime.value.close();

const cancelled = await new ClaudeLocalAgentDriver(async () => {
  throw new DOMException("cancelled", "AbortError");
}).createRuntime(context);

assert.equal(cancelled.isErr(), true);

if (cancelled.isErr()) assert.equal(cancelled.error.code, "PROVIDER_CANCELLED");

const execution = await new ClaudeLocalAgentDriver(async () => {
  throw new Error("sdk failed");
}).createRuntime(context);

assert.equal(execution.isErr(), true);

if (execution.isErr()) assert.equal(execution.error.code, "PROVIDER_EXECUTION_ERROR");

const brokenStreamQuery: ClaudeQueryLike = {
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
        });
      },
    };
  },
  close() {},
  async setPermissionMode() {},
  async applyFlagSettings() {},
};

const brokenStreamRuntimeResult = await new ClaudeLocalAgentDriver(async () => brokenStreamQuery).createRuntime(context);

assert.equal(brokenStreamRuntimeResult.isOk(), true);

if (brokenStreamRuntimeResult.isErr()) throw brokenStreamRuntimeResult.error;

const brokenStream = await brokenStreamRuntimeResult.value.run({ prompt: "fail", workspaceRoot: "/tmp/project" });

assert.equal(brokenStream.isErr(), true);

if (brokenStream.isErr()) {
  assert.equal(brokenStream.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(brokenStream.error.retryable, true);
}

await assert.rejects(
  new ClaudeLocalAgentDriver(async () => {
    throw new TypeError("internal defect");
  }).createRuntime(context),
  TypeError,
  "programmer defects must not be reclassified as provider failures",
);

let configuredOptions: Options | undefined;

const configuredDriver = createLocalAgentDrivers({
  env: {
    PATH: "/usr/bin",
    CLAUDE_COMMAND: "/usr/bin/claude",
    ANTHROPIC_API_KEY: "inherited",
    INHERITED: "yes",
  },
  subagents: subagentsConfigSchema.parse({
    enabled: true,
    providers: [{
      id: "claude",
      enabled: true,
      command: "/opt/bin/claude-wrapper",
      env: { ANTHROPIC_API_KEY: "configured", EMPTY_VALUE: "" },
    }],
  }),
  claudeQueryFactory: ({ prompt, options }) => {
    configuredOptions = options;

    return new FakeClaudeQuery(prompt);
  },
}).find((driver) => driver.provider === "claude");

assert.ok(configuredDriver);

const configuredRuntime = await configuredDriver.createRuntime(context);

assert.equal(configuredRuntime.isOk(), true);

if (configuredRuntime.isErr()) throw configuredRuntime.error;

assert.equal(configuredOptions?.pathToClaudeCodeExecutable, "/opt/bin/claude-wrapper");

assert.deepEqual(configuredOptions?.env, {
  PATH: "/usr/bin",
  CLAUDE_COMMAND: "/opt/bin/claude-wrapper",
  ANTHROPIC_API_KEY: "configured",
  INHERITED: "yes",
  EMPTY_VALUE: "",
});

await configuredRuntime.value.close();
