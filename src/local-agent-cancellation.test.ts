import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentProviderCancelledError,
  AgentProviderExecutionError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
  type LocalAgentRuntime,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";

type Outcome = "success" | "failure" | "cancelled";

class ControlledRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  started = false;
  input?: LocalAgentRunInput;
  private releaseRun: (() => void) | undefined;

  constructor(private readonly outcome: Outcome) {}

  async run(input: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.started = true;
    this.input = input;
    await new Promise<void>((resolve) => { this.releaseRun = resolve; });
    if (this.outcome === "failure") {
      return Result.err(new AgentProviderExecutionError({
        code: "PROVIDER_EXECUTION_ERROR", provider: "codex", operation: "run",
        retryable: false, message: "provider failed after cancellation request",
      }));
    }
    if (this.outcome === "cancelled") {
      return Result.err(new AgentProviderCancelledError({
        code: "PROVIDER_CANCELLED", provider: "codex", operation: "run",
        retryable: false, message: "provider confirmed cancellation",
      }));
    }
    return Result.ok({
      provider: "codex", providerSessionId: "thread_late",
      finalResponse: `late:${input.prompt}`, items: [],
    });
  }

  release(): void { this.releaseRun?.(); }
  releaseSession(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { this.release(); return Promise.resolve(); }
  isAlive(): boolean { return true; }
}

for (const expected of [
  { outcome: "success", status: "completed" },
  { outcome: "failure", status: "failed" },
  { outcome: "cancelled", status: "stopped" },
] as const) {
  test(`stop fences the exact turn until the provider settles as ${expected.status}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "devspace-agent-cancel-test-"));
    const store = new LocalAgentStore(join(root, "state"));
    let runtime: ControlledRuntime | undefined;
    const driver: LocalAgentDriver = {
      provider: "codex",
      runtimeKey: (context) => context.agentId,
      createRuntime: async () => {
        runtime = new ControlledRuntime(expected.outcome);
        return Result.ok(runtime);
      },
    };
    const profile: LocalAgentProfile = {
      name: "reviewer", description: "Test reviewer", provider: "codex",
      filePath: join(root, "reviewer.md"), body: "Review only.", disabled: false,
    };
    const manager = new LocalAgentManager({
      store, drivers: [driver], pool: new LocalAgentRuntimePool(),
      loadProfiles: async () => [profile], allowedRoots: [root],
      subagents: {
        enabled: true, instructions: "on-demand",
        providers: [{ id: "codex", enabled: true }],
      },
    });

    try {
      const started = unwrap(await manager.startTurn({
        target: "reviewer", prompt: "hold", workspaceId: "ws_test", workspaceRoot: root,
        workflowRunId: "wfr_1", workflowStepId: "wfs_1", workflowAttemptId: "wfa_1",
      }));
      await waitFor(() => runtime?.started === true);
      assert.equal(runtime?.input?.workflowRunId, "wfr_1");
      assert.equal(runtime?.input?.workflowStepId, "wfs_1");
      assert.equal(runtime?.input?.workflowAttemptId, "wfa_1");
      let stopSettled = false;
      const stopping = manager.stop(started.agent.id, started.turn.id, {
        workspaceId: "ws_test", workspaceRoot: root,
      }).then((result) => { stopSettled = true; return result; });

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopSettled, false, "stop must wait for provider acknowledgement");
      const conflict = await manager.continue(started.agent.id, "next", {}, {
        workspaceId: "ws_test", workspaceRoot: root,
      });
      assert.equal(conflict.isErr(), true, "the session remains fenced while cancellation is unconfirmed");
      if (conflict.isErr()) assert.equal(conflict.error.code, "AGENT_CONFLICT");

      runtime?.release();
      const stopped = unwrap(await stopping);
      assert.equal(stopped.status, expected.status);
      if (expected.outcome === "success") assert.match(stopped.response ?? "", /late:/);
      if (expected.outcome === "failure") assert.equal(stopped.errorCode, "PROVIDER_EXECUTION_ERROR");
      if (expected.outcome === "cancelled") assert.equal(stopped.errorCode, "AGENT_STOPPED");
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
