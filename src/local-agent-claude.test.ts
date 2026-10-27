import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeLocalAgentDriver,
  claudeAuthoritySettings,
  type ClaudeQueryLike,
  type ClaudeUserMessage,
} from "./local-agent-claude.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { parseSubagentsConfig } from "./local-agent-config.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakeClaudeQuery implements ClaudeQueryLike, AsyncIterator<unknown> {
  private readonly iterator: AsyncIterator<ClaudeUserMessage>;
  private readonly pending: unknown[] = [];
  closeCount = 0;
  model?: string;
  permissionModes: string[] = [];
  flagSettings: Array<Record<string, unknown>> = [];

  constructor(prompt: AsyncIterable<ClaudeUserMessage>) {
    this.iterator = prompt[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    if (this.pending.length > 0) return { done: false, value: this.pending.shift() };
    const next = await this.iterator.next();

    if (next.done) return { done: true, value: undefined };

    if (next.value.message.content === "use tools") {
      this.pending.push(
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "The tests fail." }] } },
        { type: "result", session_id: "claude_session_1", result: "done" },
      );

      return {
        done: false,
        value: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } }] },
        },
      };
    }

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

  async interrupt(): Promise<void> {}

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flagSettings.push({ ...settings });
  }

  async setModel(model?: string): Promise<void> {
    this.model = model;
  }
}

const context: LocalAgentRuntimeContext = {
  agentId: "agt_claude",
  providerInstanceId: "claude",
  provider: "claude",
  workspaceRoot: "/tmp/project",
  model: "sonnet",
  effort: "high",
  writeMode: "read_only",
};

function claudeDriverFixture() {
  const state = {
    factoryCalls: 0,
    lastOptions: undefined as Record<string, unknown> | undefined,
    query: undefined as FakeClaudeQuery | undefined,
  };

  const driver = new ClaudeLocalAgentDriver(({ prompt, options }) => {
    state.factoryCalls += 1;
    state.lastOptions = options;
    state.query = new FakeClaudeQuery(prompt);

    return state.query;
  }, { PATH: "/usr/bin" });

  return { driver, state };
}

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
  async interrupt() {},
  async setPermissionMode() {},
  async applyFlagSettings() {},
};

function configuredClaudeDriver(onOptions: (options: Record<string, unknown>) => void) {
  return createLocalAgentDrivers({
    env: {
      PATH: "/usr/bin",
      CLAUDE_COMMAND: "/usr/bin/claude",
      ANTHROPIC_API_KEY: "inherited",
      INHERITED: "yes",
    },
    subagents: parseSubagentsConfig({
      enabled: true,
      providers: [{
        id: "claude",
        enabled: true,
        command: "/opt/bin/claude-wrapper",
        env: { ANTHROPIC_API_KEY: "configured", EMPTY_VALUE: "" },
      }],
    }),
    claudeQueryFactory: ({ prompt, options }) => {
      onOptions(options);

      return new FakeClaudeQuery(prompt);
    },
  }).find((driver) => driver.provider === "claude");
}

test("the Claude driver keeps an agent-scoped runtime behind the full-access boundary", () => {
  const { driver } = claudeDriverFixture();
  assert.deepEqual(driver.runtimePolicy, {
    scope: "agent",
    authority: "full_access_boundary",
    idleTimeoutMs: 3 * 60_000,
  });
});

test("successive turns reuse one Claude query and apply each turn's authority", async () => {
  const { driver, state } = claudeDriverFixture();
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
  assert.equal(state.factoryCalls, 1, "successive turns reuse one Claude query");
  assert.equal(first.providerSessionId, "claude_session_1");
  assert.equal(second.finalResponse, "response:second");
  assert.equal(state.query?.model, "sonnet");
  assert.equal(state.lastOptions?.resume, undefined);
  assert.equal(state.lastOptions?.permissionMode, "dontAsk");
  assert.equal(state.lastOptions?.allowDangerouslySkipPermissions, undefined);
  assert.deepEqual(state.lastOptions?.allowedTools, ["Read(/**)", "Edit(/**)", "Bash"]);
  assert.equal(state.lastOptions?.pathToClaudeCodeExecutable, undefined);
  const initialSandbox = state.lastOptions?.sandbox as Record<string, unknown>;
  assert.equal(initialSandbox.enabled, true);
  assert.equal(initialSandbox.failIfUnavailable, true);
  assert.equal(initialSandbox.autoAllowBashIfSandboxed, true);
  assert.equal(initialSandbox.allowUnsandboxedCommands, false);
  assert.deepEqual((initialSandbox.filesystem as Record<string, unknown>).allowWrite, []);
  assert.deepEqual((initialSandbox.filesystem as Record<string, unknown>).denyWrite, ["/tmp/project"]);
  assert.deepEqual(sessionIds, ["claude_session_1"]);
  assert.deepEqual(state.query?.permissionModes, ["dontAsk", "dontAsk", "bypassPermissions"]);
  assert.equal(state.query?.flagSettings.length, 3);
  assert.equal(state.query?.flagSettings[0]?.alwaysThinkingEnabled, true);
  assert.equal(state.query?.flagSettings[0]?.effortLevel, "high");
  assert.equal(
    (state.query?.flagSettings[0]?.permissions as Record<string, unknown>).defaultMode,
    "dontAsk",
  );
  assert.equal(state.query?.flagSettings[1]?.effortLevel, "low");
  assert.equal(
    ((state.query?.flagSettings[1]?.permissions as Record<string, unknown>).deny as string[]).includes("Edit"),
    false,
  );
  assert.equal(
    (state.query?.flagSettings[2]?.permissions as Record<string, unknown>).defaultMode,
    "bypassPermissions",
  );

  await runtime.close();
  await runtime.close();
  assert.equal(state.query?.closeCount, 1);
});

test("authority settings map each write mode to permissions and sandbox", () => {
  const allowedSettings = claudeAuthoritySettings("/tmp/project", "allowed");
  const allowedPermissions = allowedSettings.permissions as Record<string, unknown>;
  const allowedSandbox = allowedSettings.sandbox as Record<string, unknown>;
  assert.deepEqual(allowedPermissions.deny, []);
  assert.deepEqual(allowedSandbox.filesystem, {
    allowWrite: ["/tmp/project"],
    denyWrite: [],
  });
  const readOnlySettings = claudeAuthoritySettings("/tmp/project", "read_only");
  const readOnlyPermissions = readOnlySettings.permissions as Record<string, unknown>;
  assert.ok((readOnlyPermissions.deny as string[]).includes("Bash"));
  assert.ok((readOnlyPermissions.deny as string[]).includes("Edit"));
  assert.deepEqual(
    ((readOnlySettings.sandbox as Record<string, unknown>).filesystem as Record<string, unknown>).allowWrite,
    [],
  );
  const fullSettings = claudeAuthoritySettings("/tmp/project", "full_access");
  assert.deepEqual((fullSettings.sandbox as Record<string, unknown>), {
    enabled: false,
    allowUnsandboxedCommands: true,
  });
});

test("a cold runtime resumes its provider session", async () => {
  const { driver, state } = claudeDriverFixture();
  const coldRuntime = await driver.createRuntime({ ...context, providerSessionId: "cold_session" });
  assert.equal(coldRuntime.isOk(), true);
  assert.equal(state.lastOptions?.resume, "cold_session");
});

test("CLAUDE_COMMAND overrides the Claude Code executable", async () => {
  let lastOptions: Record<string, unknown> | undefined;

  const customCommandDriver = new ClaudeLocalAgentDriver(({ prompt, options }) => {
    lastOptions = options;

    return new FakeClaudeQuery(prompt);
  }, { CLAUDE_COMMAND: "/opt/claude" });

  const customCommandRuntime = await customCommandDriver.createRuntime(context);
  assert.equal(customCommandRuntime.isOk(), true);
  assert.equal(lastOptions?.pathToClaudeCodeExecutable, "/opt/claude");

  if (customCommandRuntime.isOk()) await customCommandRuntime.value.close();
});

test("an aborted SDK start is a cancelled error", async () => {
  const cancelled = await new ClaudeLocalAgentDriver(async () => {
    throw new DOMException("cancelled", "AbortError");
  }).createRuntime(context);

  assert.equal(cancelled.isErr(), true);

  if (cancelled.isErr()) assert.equal(cancelled.error.code, "PROVIDER_CANCELLED");
});

test("an SDK start failure is an execution error", async () => {
  const execution = await new ClaudeLocalAgentDriver(async () => {
    throw new Error("sdk failed");
  }).createRuntime(context);

  assert.equal(execution.isErr(), true);

  if (execution.isErr()) assert.equal(execution.error.code, "PROVIDER_EXECUTION_ERROR");
});

test("a refused connection mid-stream is a retryable unavailable error", async () => {
  const brokenStreamRuntimeResult = await new ClaudeLocalAgentDriver(async () => brokenStreamQuery).createRuntime(context);
  assert.equal(brokenStreamRuntimeResult.isOk(), true);

  if (brokenStreamRuntimeResult.isErr()) throw brokenStreamRuntimeResult.error;
  const brokenStream = await brokenStreamRuntimeResult.value.run({ prompt: "fail", workspaceRoot: "/tmp/project" });
  assert.equal(brokenStream.isErr(), true);

  if (brokenStream.isErr()) {
    assert.equal(brokenStream.error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(brokenStream.error.retryable, true);
  }
});

test("a missing Claude Code native binary is unavailable", async () => {
  const missingExecutableQuery: ClaudeQueryLike = {
    ...brokenStreamQuery,
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new ReferenceError("Claude Code native binary not found at /missing/claude. Please ensure Claude Code is installed.");
        },
      };
    },
  };

  const missingExecutableRuntime = await new ClaudeLocalAgentDriver(async () => missingExecutableQuery).createRuntime(context);

  if (missingExecutableRuntime.isErr()) throw missingExecutableRuntime.error;
  const missingExecutable = await missingExecutableRuntime.value.run({ prompt: "fail", workspaceRoot: "/tmp/project" });
  assert.equal(missingExecutable.isErr() && missingExecutable.error.code, "PROVIDER_UNAVAILABLE");
});

test("programmer defects are not reclassified as provider failures", async () => {
  await assert.rejects(
    new ClaudeLocalAgentDriver(async () => {
      throw new TypeError("internal defect");
    }).createRuntime(context),
    TypeError,
    "programmer defects must not be reclassified as provider failures",
  );
});

test("a configured provider command and env reach the Claude SDK", async () => {
  let configuredOptions: Record<string, unknown> | undefined;
  const configuredDriver = configuredClaudeDriver((options) => { configuredOptions = options; });
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
});

// Complete SDK messages map onto tool and message events; tool results resolve their tool_use.
test("complete SDK messages map onto tool and message events", async () => {
  const configuredDriver = configuredClaudeDriver(() => {});
  assert.ok(configuredDriver);
  const configuredRuntime = await configuredDriver.createRuntime(context);

  if (configuredRuntime.isErr()) throw configuredRuntime.error;
  assert.equal(configuredDriver.capabilities.turns.streaming, true);
  const claudeEvents: unknown[] = [];

  const streamed = await configuredRuntime.value.run({ prompt: "use tools", workspaceRoot: "/tmp/project" }, {
    onEvent: (event) => { claudeEvents.push(event); },
  });

  assert.equal(streamed.isOk() && streamed.value.finalResponse, "done");
  assert.deepEqual(claudeEvents, [
    { type: "tool_started", tool: "Bash", summary: "pnpm test" },
    { type: "tool_completed", tool: "Bash", summary: "pnpm test", status: "failed" },
    { type: "message", text: "The tests fail." },
  ]);
  await configuredRuntime.value.close();
});
