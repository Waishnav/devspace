import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentRunController, type LocalAgentRunHandle } from "../local-agent-runtime.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import { executeWorkflowRuntime, parseWorkflowRuntimeSource } from "./runtime.js";
import { runWorkflowSupervisor } from "./supervisor.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-runtime-test-"));
try {
  await testParallelPipelineRuntime(join(root, "parallel"));
  await testPrefixReplay(join(root, "replay"));
  await testRestrictedGlobalsAndBudget(join(root, "sandbox"));
  await testUnawaitedAgentFails(join(root, "unawaited"));
  testMetadataValidation();
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function testParallelPipelineRuntime(stateDir: string): Promise<void> {
  const orchestrator = new WorkflowOrchestrator(stateDir);
  let active = 0;
  let maximum = 0;
  const prompts: string[] = [];
  const handleFactory = async (_provider: string, input: { prompt: string }): Promise<LocalAgentRunHandle> => {
    active += 1;
    maximum = Math.max(maximum, active);
    prompts.push(input.prompt);
    const controller = new LocalAgentRunController("fake");
    const timer = setTimeout(() => {
      active -= 1;
      controller.succeed({
        provider: "fake",
        providerSessionId: `runtime-${input.prompt}`,
        finalResponse: `result:${input.prompt}`,
        items: [],
      });
    }, 30);
    controller.setLifecycle({
      cancel: () => {
        clearTimeout(timer);
        active = Math.max(0, active - 1);
      },
      dispose: () => clearTimeout(timer),
    });
    return controller;
  };
  const wakeSupervisor = async () => {
    await runWorkflowSupervisor(stateDir, {
      handleFactory,
      globalConcurrency: 4,
      heartbeatMs: 5,
      nodeLeaseMs: 500,
      supervisorLeaseMs: 500,
      idleMs: 0,
    });
  };
  const source = `
// @devspace-workflow {"version":1,"name":"parallel-test","maxAgentCalls":3,"maxConcurrency":2,"timeoutMs":5000}
export default async function ({ agent, parallel, pipeline, phase, log, args }) {
  const pair = await phase("research", () => parallel([
    () => agent({ target: "fake", prompt: args.first }),
    () => agent({ target: "fake", prompt: args.second })
  ]));
  log("research complete", { count: pair.length });
  const final = await pipeline([
    (value) => agent({ target: "fake", prompt: value[0].finalResponse + "+summary" })
  ], pair);
  return { pair, final };
}
`;
  try {
    const result = await executeWorkflowRuntime({
      stateDir,
      worktreeRoot: join(stateDir, "worktrees"),
      source,
      args: { first: "alpha", second: "beta" },
      workspace: { workspaceId: "workspace", workspaceRoot: root },
      profiles: [],
      idempotencyKey: "parallel-runtime",
      environment: { ...process.env, DEVSPACE_WORKFLOW_FAKE_PROVIDER: "1" },
      orchestrator,
      wakeSupervisor,
    });
    assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
    assert.equal(maximum, 2);
    assert.deepEqual(prompts.slice(0, 2).sort(), ["alpha", "beta"]);
    assert.equal(prompts[2], "result:alpha+summary");
    const output = result.run.result as { final: { finalResponse: string } };
    assert.equal(output.final.finalResponse, "result:result:alpha+summary");
  } finally {
    orchestrator.close();
  }
}

async function testPrefixReplay(stateDir: string): Promise<void> {
  const orchestrator = new WorkflowOrchestrator(stateDir);
  let starts = 0;
  const handleFactory = async (_provider: string, input: { prompt: string }): Promise<LocalAgentRunHandle> => {
    starts += 1;
    const controller = new LocalAgentRunController("fake");
    queueMicrotask(() => controller.succeed({
      provider: "fake",
      providerSessionId: `replay-${starts}`,
      finalResponse: input.prompt,
      items: [],
    }));
    return controller;
  };
  const wakeSupervisor = async () => {
    await runWorkflowSupervisor(stateDir, {
      handleFactory,
      heartbeatMs: 5,
      nodeLeaseMs: 500,
      supervisorLeaseMs: 500,
      idleMs: 0,
    });
  };
  const source = `
// @devspace-workflow {"version":1,"maxAgentCalls":1,"timeoutMs":5000}
export default async function ({ agent }) {
  await agent({ target: "fake", prompt: "once" });
  throw new Error("intentional failure after durable prefix");
}
`;
  try {
    const input = {
      stateDir,
      worktreeRoot: join(stateDir, "worktrees"),
      source,
      args: {},
      workspace: { workspaceId: "workspace", workspaceRoot: root },
      profiles: [],
      idempotencyKey: "prefix-replay",
      environment: { ...process.env, DEVSPACE_WORKFLOW_FAKE_PROVIDER: "1" },
      orchestrator,
      wakeSupervisor,
    };
    const first = await executeWorkflowRuntime(input);
    assert.equal(first.run.status, "failed");
    assert.equal(starts, 1);
    const replay = await executeWorkflowRuntime(input);
    assert.equal(replay.run.status, "failed");
    assert.equal(replay.replayedCalls, 1);
    assert.equal(starts, 1, "completed prefix must not execute the provider twice");
  } finally {
    orchestrator.close();
  }
}

async function testRestrictedGlobalsAndBudget(stateDir: string): Promise<void> {
  const source = `
// @devspace-workflow {"version":1,"maxAgentCalls":7,"maxConcurrency":3,"timeoutMs":5000}
export default function ({ args, budget }) {
  return {
    args,
    budget,
    globals: {
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch
    }
  };
}
`;
  const result = await executeWorkflowRuntime({
    stateDir,
    worktreeRoot: join(stateDir, "worktrees"),
    source,
    args: { value: "safe" },
    workspace: { workspaceId: "workspace", workspaceRoot: root },
    profiles: [],
  });
  assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
  assert.deepEqual(result.run.result, {
    args: { value: "safe" },
    budget: { maxAgentCalls: 7, maxConcurrency: 3, timeoutMs: 5000 },
    globals: { process: "undefined", require: "undefined", fetch: "undefined" },
  });
}

async function testUnawaitedAgentFails(stateDir: string): Promise<void> {
  const orchestrator = new WorkflowOrchestrator(stateDir);
  const handleFactory = async (): Promise<LocalAgentRunHandle> => {
    const controller = new LocalAgentRunController("fake");
    const timer = setTimeout(() => controller.succeed({
      provider: "fake",
      providerSessionId: "late-session",
      finalResponse: "late",
      items: [],
    }), 5_000);
    controller.setLifecycle({
      cancel: () => {
        clearTimeout(timer);
      },
      dispose: () => clearTimeout(timer),
    });
    return controller;
  };
  try {
    const result = await executeWorkflowRuntime({
      stateDir,
      worktreeRoot: join(stateDir, "worktrees"),
      source: `
// @devspace-workflow {"version":1,"maxAgentCalls":1,"timeoutMs":5000}
export default function ({ agent }) {
  agent({ target: "fake", prompt: "must await" });
  return { premature: true };
}
`,
      args: {},
      workspace: { workspaceId: "workspace", workspaceRoot: root },
      profiles: [],
      environment: { ...process.env, DEVSPACE_WORKFLOW_FAKE_PROVIDER: "1" },
      orchestrator,
      wakeSupervisor: async () => runWorkflowSupervisor(stateDir, {
        handleFactory,
        heartbeatMs: 5,
        nodeLeaseMs: 500,
        supervisorLeaseMs: 500,
        idleMs: 0,
      }),
    });
    assert.equal(result.run.status, "failed");
    assert.match(String(result.run.error?.message), /before all agent\(\) calls were awaited/);
  } finally {
    orchestrator.close();
  }
}

function testMetadataValidation(): void {
  assert.throws(
    () => parseWorkflowRuntimeSource(`// @devspace-workflow {"version":1,"unknown":true}\nexport default function () {}`),
    /Unknown workflow metadata field/,
  );
  assert.throws(
    () => parseWorkflowRuntimeSource("export const workflow = () => null"),
    /default function declaration/,
  );
}
