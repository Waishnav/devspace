import assert from "node:assert/strict";
import {
  ClaudeLocalAgentDriver,
  claudeAuthoritySettings,
  type ClaudeQueryLike,
  type ClaudeUserMessage,
} from "./local-agent-claude.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakeClaudeQuery implements ClaudeQueryLike, AsyncIterator<unknown> {
  private readonly iterator: AsyncIterator<ClaudeUserMessage>;
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

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
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
let lastOptions: Record<string, unknown> | undefined;
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
const initialSandbox = lastOptions?.sandbox as Record<string, unknown>;
assert.equal(initialSandbox.enabled, true);
assert.equal(initialSandbox.failIfUnavailable, true);
assert.equal(initialSandbox.autoAllowBashIfSandboxed, true);
assert.equal(initialSandbox.allowUnsandboxedCommands, false);
assert.deepEqual((initialSandbox.filesystem as Record<string, unknown>).allowWrite, []);
assert.deepEqual((initialSandbox.filesystem as Record<string, unknown>).denyWrite, ["/tmp/project"]);
const allowedSettings = claudeAuthoritySettings("/tmp/project", "allowed");
const allowedPermissions = allowedSettings.permissions as Record<string, unknown>;
const allowedSandbox = allowedSettings.sandbox as Record<string, unknown>;
assert.ok((allowedPermissions.allow as string[]).includes("Bash(*)"));
assert.deepEqual(allowedSandbox.filesystem, {
  allowWrite: ["/tmp/project"],
  denyWrite: [],
  denyRead: (allowedSandbox.filesystem as Record<string, unknown>).denyRead,
  allowRead: ["/tmp/project"],
});
const readOnlySettings = claudeAuthoritySettings("/tmp/project", "read_only");
const readOnlyPermissions = readOnlySettings.permissions as Record<string, unknown>;
assert.equal((readOnlyPermissions.allow as string[]).some((rule) => rule.startsWith("Edit(")), false);
assert.ok((readOnlyPermissions.deny as string[]).includes("Bash(*)"));
assert.deepEqual(
  ((readOnlySettings.sandbox as Record<string, unknown>).filesystem as Record<string, unknown>).allowWrite,
  [],
);
const fullSettings = claudeAuthoritySettings("/tmp/project", "full_access");
assert.deepEqual((fullSettings.sandbox as Record<string, unknown>), {
  enabled: false,
  allowUnsandboxedCommands: true,
});
assert.deepEqual(sessionIds, ["claude_session_1"]);
assert.deepEqual(query?.permissionModes, ["dontAsk", "dontAsk", "bypassPermissions"]);
assert.equal(query?.flagSettings.length, 3);
assert.equal(query?.flagSettings[0]?.alwaysThinkingEnabled, true);
assert.equal(query?.flagSettings[0]?.effortLevel, "high");
assert.equal(
  (query?.flagSettings[0]?.permissions as Record<string, unknown>).defaultMode,
  "dontAsk",
);
assert.equal(query?.flagSettings[1]?.effortLevel, "low");
assert.ok(
  ((query?.flagSettings[1]?.permissions as Record<string, unknown>).allow as string[]).includes("Bash(*)"),
);
assert.equal(
  (query?.flagSettings[2]?.permissions as Record<string, unknown>).defaultMode,
  "bypassPermissions",
);

await runtime.close();
await runtime.close();
assert.equal(query?.closeCount, 1);

const coldRuntime = await driver.createRuntime({ ...context, providerSessionId: "cold_session" });
assert.equal(coldRuntime.isOk(), true);
assert.equal(lastOptions?.resume, "cold_session");

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
