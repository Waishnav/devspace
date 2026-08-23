import assert from "node:assert/strict";
import { Panic, Result, type Result as BetterResult } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentManager } from "./local-agent-manager.js";
import {
  AgentProviderExecutionError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-manager-test-"));
const directRoot = await mkdtemp(join(tmpdir(), "devspace-direct-agent-manager-test-"));
const stateDir = join(root, "state");
const scope = { workspaceId: "ws_test", workspaceRoot: root };
const profile: LocalAgentProfile = {
  name: "reviewer",
  description: "Test reviewer",
  provider: "codex",
  filePath: join(root, "reviewer.md"),
  body: "Review only.",
  disabled: false,
};
const disabledProfile: LocalAgentProfile = {
  ...profile,
  name: "disabled-reviewer",
  filePath: join(root, "disabled-reviewer.md"),
  disabled: true,
};
const subagents: SubagentsConfig = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-default", effort: "medium" },
    { id: "claude", enabled: true },
  ],
};

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  readonly inputs: LocalAgentRunInput[] = [];
  closed = false;
  private releaseHold: (() => void) | undefined;

  async run(
    input: LocalAgentRunInput,
    callbacks?: { onSessionId?: (id: string) => void | Promise<void> },
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(input);
    if (input.prompt.includes("early-fail")) {
      await callbacks?.onSessionId?.("thread_early");
      return Result.err(providerFailure("provider failed after session creation"));
    }
    if (input.prompt.includes("defect")) throw new TypeError("internal defect");
    if (input.prompt.includes("fail")) return Result.err(providerFailure("provider failed"));
    if (input.prompt.includes("hold")) {
      await new Promise<void>((resolve) => { this.releaseHold = resolve; });
    }
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_test",
      finalResponse: `response:${input.prompt}`,
      items: [],
    });
  }

  release(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
}

const runtimes = new Map<string, FakeRuntime>();
const driver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeRuntime();
    runtimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

function providerFailure(message: string): AgentProviderExecutionError {
  return new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "codex",
    operation: "run",
    retryable: false,
    message,
  });
}

const store = new LocalAgentStore(stateDir);
const stale = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: "reviewer",
  provider: "codex",
});
store.update(stale.id, { status: "running", latestResponse: "previous response" });

const manager = new LocalAgentManager({
  store,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile, disabledProfile],
  allowedRoots: [root],
  subagents,
});

const defectStore = new LocalAgentStore(join(root, "defect-state"));
const defectManager = new LocalAgentManager({
  store: defectStore,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => {
    throw new TypeError("profile loader defect");
  },
  allowedRoots: [root],
  subagents,
});
await assert.rejects(
  defectManager.start({
    target: "reviewer",
    prompt: "inspect",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }),
  (error: unknown) => Panic.is(error) && error.cause instanceof TypeError,
);
await defectManager.close();

const outside = await manager.start({
  target: "reviewer",
  prompt: "outside",
  workspaceId: scope.workspaceId,
  workspaceRoot: join(tmpdir(), "outside"),
});
assert.equal(outside.isErr(), true);
if (outside.isErr()) assert.equal(outside.error.code, "WORKSPACE_NOT_ALLOWED");

const unknown = await manager.start({
  target: "missing",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unknown.isErr(), true);
if (unknown.isErr()) assert.equal(unknown.error.code, "UNKNOWN_TARGET");

const disabled = await manager.start({
  target: "disabled-reviewer",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabled.isErr(), true);
if (disabled.isErr()) assert.equal(disabled.error.code, "PROVIDER_DISABLED");

const unconfigured = await manager.start({
  target: "claude",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unconfigured.isErr(), true);
if (unconfigured.isErr()) assert.equal(unconfigured.error.code, "PROVIDER_NOT_CONFIGURED");

const disabledProvider = await manager.start({
  target: "pi",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabledProvider.isErr(), true);
if (disabledProvider.isErr()) assert.equal(disabledProvider.error.code, "PROVIDER_DISABLED");

const previouslyCreatedDisabled = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: disabledProfile.name,
  provider: "codex",
});
store.update(previouslyCreatedDisabled.id, { status: "idle" });
const disabledContinuation = await manager.continue(previouslyCreatedDisabled.id, "inspect", {}, scope);
assert.equal(disabledContinuation.isErr(), true);
if (disabledContinuation.isErr()) assert.equal(disabledContinuation.error.code, "PROVIDER_DISABLED");

assert.equal(getRecord(stale.id).status, "running");

const mismatchedGet = manager.get(stale.id, { workspaceId: "ws_current", workspaceRoot: root });
assert.equal(mismatchedGet.isErr(), true);
if (mismatchedGet.isErr()) assert.equal(mismatchedGet.error.code, "WORKSPACE_MISMATCH");

unwrap(manager.reconcileActiveRuns());
assert.equal(getRecord(stale.id).status, "error");
assert.equal(getRecord(stale.id).latestResponse, "previous response");
assert.equal(getRecord(stale.id).error, "DevSpace restarted while this agent turn was running.");
assert.equal(getRecord(stale.id).errorCode, "DAEMON_UNAVAILABLE");
assert.equal(getRecord(stale.id).errorRetryable, true);

const first = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
assert.equal(first.status, "running");
assert.equal(first.model, "gpt-default");
assert.equal(first.effort, "medium");
await waitFor(() => runtimes.get(first.id)?.inputs.length === 1);
const conflict = await manager.continue(first.id, "another prompt", {}, scope);
assert.equal(conflict.isErr(), true);
if (conflict.isErr()) {
  assert.equal(conflict.error.code, "AGENT_CONFLICT");
  assert.equal("agentId" in conflict.error ? conflict.error.agentId : undefined, first.id);
}

runtimes.get(first.id)!.release();
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).providerSessionId, "thread_test");
assert.match(getRecord(first.id).latestResponse ?? "", /Task:\nhold/);

const continued = unwrap(await manager.continue(first.id, "continue", {
  model: "gpt-run",
  effort: "high",
}, scope));
assert.equal(continued.status, "running");
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).model, "gpt-run");
assert.equal(getRecord(first.id).effort, "high");

const second = unwrap(await manager.start({
  target: "reviewer",
  prompt: "second agent",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(second.id).status === "idle");
assert.notEqual(first.id, second.id);
assert.equal(runtimes.size, 2, "different agents receive independent logical runtimes");

const failed = unwrap(await manager.start({
  target: "reviewer",
  prompt: "fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(failed.id).status === "error");
assert.equal(getRecord(failed.id).error, "provider failed");
assert.equal(getRecord(failed.id).errorCode, "PROVIDER_EXECUTION_ERROR");
assert.equal(getRecord(failed.id).errorRetryable, false);
const recovered = unwrap(await manager.continue(failed.id, "recovered", {}, scope));
assert.equal(recovered.status, "running", "provider Err releases active-turn ownership");
await waitFor(() => getRecord(failed.id).status === "idle");

const earlyFailure = unwrap(await manager.start({
  target: "reviewer",
  prompt: "early-fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(earlyFailure.id).status === "error");
assert.equal(getRecord(earlyFailure.id).providerSessionId, "thread_early");

const wrongWorkspace = await manager.continue(
  first.id,
  "wrong workspace",
  {},
  { workspaceId: scope.workspaceId, workspaceRoot: join(root, "other") },
);
assert.equal(wrongWorkspace.isErr(), true);
if (wrongWorkspace.isErr()) assert.equal(wrongWorkspace.error.code, "WORKSPACE_MISMATCH");

const wrongWorkspaceId = await manager.continue(
  first.id,
  "wrong workspace id",
  {},
  { workspaceId: "ws_other", workspaceRoot: root },
);
assert.equal(wrongWorkspaceId.isErr(), true);
if (wrongWorkspaceId.isErr()) assert.equal(wrongWorkspaceId.error.code, "WORKSPACE_MISMATCH");

const directOutside = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct outside allowed roots",
  workspaceRoot: directRoot,
}));
await waitFor(() => unwrap(manager.get(directOutside.id, { workspaceRoot: directRoot })).status === "idle");
assert.equal(directOutside.workspaceId, undefined);
assert.deepEqual(unwrap(manager.list({ workspaceRoot: directRoot })).map((record) => record.id), [
  directOutside.id,
]);

const direct = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct harness",
  workspaceRoot: root,
}));
await waitFor(() => unwrap(manager.get(direct.id, { workspaceRoot: root })).status === "idle");
assert.equal(direct.workspaceId, undefined);
assert.equal(unwrap(manager.get(first.id, { workspaceRoot: root })).id, first.id);
const directWrongId = manager.get(direct.id, { workspaceId: "ws_other", workspaceRoot: root });
assert.equal(directWrongId.isErr(), true);
if (directWrongId.isErr()) assert.equal(directWrongId.error.code, "WORKSPACE_MISMATCH");

const defect = unwrap(await manager.start({
  target: "reviewer",
  prompt: "defect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(defect.id).status === "error");
assert.equal(getRecord(defect.id).errorCode, "AGENT_INTERNAL_ERROR");
assert.notEqual(getRecord(defect.id).errorCode, "PROVIDER_EXECUTION_ERROR");

const shuttingDown = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold during shutdown",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(shuttingDown.id)?.inputs.length === 1);
const closing = manager.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(runtimes.get(shuttingDown.id)?.closed, true);
await closing;

await manager.close();
await rm(root, { recursive: true, force: true });
await rm(directRoot, { recursive: true, force: true });

function getRecord(id: string) {
  return unwrap(manager.get(id, scope));
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
