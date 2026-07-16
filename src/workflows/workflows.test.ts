import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/client.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import {
  WorkflowIdempotencyConflictError,
  WorkflowStore,
  WorkflowTransitionError,
  WorkflowValidationError,
} from "./store.js";
import type { SubmitWorkflowRequest, WorkflowDefinitionV1 } from "./types.js";

interface WorkerSpec {
  action: "append" | "claim" | "submit";
  stateDir: string;
  readyPath: string;
  barrierPath: string;
  workflowId?: string;
  claimToken?: string;
  start?: number;
  count?: number;
  requestVariant?: "a" | "b" | "same";
}

const workerSpecJson = process.argv[2];
if (workerSpecJson) {
  await runWorker(JSON.parse(workerSpecJson) as WorkerSpec);
} else {
  await runTests();
}

async function runTests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "devspace-workflows-test-"));
  try {
    testSubmissionAndIdempotency(join(root, "submission"));
    await testConcurrentSubmission(join(root, "concurrent-submission"));
    testMonotonicCursorReads(join(root, "events"));
    await testConcurrentEventSequencing(join(root, "concurrent-events"));
    testCancellationIdempotency(join(root, "cancellation"));
    await testTransitionsAndClaims(join(root, "transitions"));
    testTerminalInvariantsAndAtomicity(join(root, "terminal-invariants"));
    testDagValidation(join(root, "dag"));
    await testBoundedAndRepeatedWait(join(root, "wait"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testSubmissionAndIdempotency(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  try {
    const request: SubmitWorkflowRequest = {
      definition: singleAgentDefinition({ z: true, a: "first" }),
      input: { z: 2, a: { nested: true } },
      policy: { version: 1, retries: 0 },
      idempotencyKey: " durable-request ",
    };
    const first = store.submit(request);
    assert.equal(first.created, true);
    assert.match(first.workflow.id, /^wf_[a-f0-9]{32}$/);
    assert.match(first.workflow.nodes[0]!.id, /^wfn_[a-f0-9]{32}$/);
    assert.equal(first.workflow.status, "queued");
    assert.equal(first.workflow.nodes[0]!.status, "ready");
    assert.equal(first.workflow.idempotencyKey, "durable-request");

    request.input!.a = { nested: false };
    request.definition.nodes[0]!.config!.a = "mutated";
    const persisted = store.require(first.workflow.id);
    assert.deepEqual(persisted.input, { a: { nested: true }, z: 2 });
    assert.deepEqual(persisted.definition.nodes[0]!.config, { a: "first", z: true });

    const replay = store.submit({
      definition: singleAgentDefinition({ a: "first", z: true }),
      input: { a: { nested: true }, z: 2 },
      policy: { retries: 0, version: 1 },
      idempotencyKey: "durable-request",
    });
    assert.equal(replay.created, false);
    assert.equal(replay.workflow.id, first.workflow.id);

    const specialInput = JSON.parse('{"__proto__":{"preserved":true}}') as Record<string, never>;
    const special = store.submit({ definition: singleAgentDefinition(), input: specialInput }).workflow;
    assert.equal(Object.hasOwn(special.input, "__proto__"), true);
    assert.deepEqual(special.input["__proto__"], { preserved: true });

    assert.throws(
      () =>
        store.submit({
          definition: singleAgentDefinition(),
          input: { changed: true },
          idempotencyKey: "durable-request",
        }),
      WorkflowIdempotencyConflictError,
    );
  } finally {
    store.close();
  }
}

async function testConcurrentSubmission(stateDir: string): Promise<void> {
  const same = await runWorkers(stateDir, [
    { action: "submit", requestVariant: "same" },
    { action: "submit", requestVariant: "same" },
  ]);
  assert.equal(same[0]!.workflowId, same[1]!.workflowId);
  assert.deepEqual(
    same.map((result) => result.created).sort(),
    [false, true],
  );
  assertDatabaseCounts(stateDir, { runs: 1, nodes: 1, edges: 0, events: 1 });

  const conflictDir = `${stateDir}-conflict`;
  const conflict = await runWorkers(conflictDir, [
    { action: "submit", requestVariant: "a" },
    { action: "submit", requestVariant: "b" },
  ]);
  assert.equal(conflict.filter((result) => result.created === true).length, 1);
  assert.deepEqual(
    conflict.filter((result) => result.error).map((result) => result.error),
    ["WorkflowIdempotencyConflictError"],
  );
  assertDatabaseCounts(conflictDir, { runs: 1, nodes: 1, edges: 0, events: 1 });
}

function testMonotonicCursorReads(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  try {
    const workflow = store.submit({ definition: singleAgentDefinition() }).workflow;
    store.appendEvent(workflow.id, "custom.first", { value: 1 });
    store.appendEvent(workflow.id, "custom.second", { value: 2 });

    const firstPage = store.readEvents(workflow.id, { after: 0, limit: 2 });
    assert.deepEqual(firstPage.events.map((event) => event.sequence), [1, 2]);
    assert.equal(firstPage.nextCursor, 2);
    const secondPage = store.readEvents(workflow.id, { after: firstPage.nextCursor, limit: 2 });
    assert.deepEqual(secondPage.events.map((event) => event.sequence), [3]);
    assert.equal(secondPage.nextCursor, 3);
    assert.deepEqual(
      store.readEvents(workflow.id, { after: 0, limit: 10 }).events.map((event) => event.sequence),
      [1, 2, 3],
    );

    assert.throws(
      () => store.appendEvent(workflow.id, "oversized", { body: "x".repeat(65_536) }),
      WorkflowValidationError,
    );
    assert.throws(
      () => store.appendEvent(workflow.id, "invalid", [] as unknown as Record<string, never>),
      WorkflowValidationError,
    );
  } finally {
    store.close();
  }
}

async function testConcurrentEventSequencing(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  const workflow = store.submit({ definition: singleAgentDefinition() }).workflow;
  store.close();

  await runWorkers(
    stateDir,
    Array.from({ length: 4 }, (_, worker) => ({
      action: "append" as const,
      workflowId: workflow.id,
      start: worker * 10,
      count: 10,
    })),
  );

  const reader = new WorkflowStore(stateDir);
  try {
    const events = reader.readEvents(workflow.id, { limit: 100 }).events;
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: 41 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      events.slice(1).map((event) => event.payload.value).sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 40 }, (_, index) => index),
    );
    const database = openDatabase(stateDir);
    try {
      assert.equal(
        database.sqlite.prepare("select event_sequence from workflow_runs where id = ?").pluck().get(workflow.id),
        41,
      );
    } finally {
      database.close();
    }
  } finally {
    reader.close();
  }
}

function testCancellationIdempotency(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  try {
    const workflow = store.submit({ definition: singleAgentDefinition() }).workflow;
    const first = store.requestCancellation(workflow.id);
    const firstEvents = store.readEvents(workflow.id, { limit: 100 }).events;
    const second = store.requestCancellation(workflow.id);
    const secondEvents = store.readEvents(workflow.id, { limit: 100 }).events;

    assert.equal(first.status, "cancelling");
    assert.ok(first.cancellationRequestedAt);
    assert.equal(second.cancellationRequestedAt, first.cancellationRequestedAt);
    assert.equal(secondEvents.length, firstEvents.length);
    assert.equal(secondEvents.at(-1)!.type, "workflow.cancellation_requested");

    const cancelled = store.transitionWorkflow({ workflowId: workflow.id, status: "cancelled" });
    assert.equal(cancelled.nodes[0]!.status, "cancelled");
    assert.equal(store.requestCancellation(workflow.id).status, "cancelled");
    assert.equal(store.require(workflow.id).completedAt, cancelled.completedAt);
  } finally {
    store.close();
  }
}

async function testTransitionsAndClaims(stateDir: string): Promise<void> {
  const store = new WorkflowStore(stateDir);
  try {
    const workflow = store.submit({ definition: singleAgentDefinition() }).workflow;
    const raced = await runWorkers(stateDir, [
      { action: "claim", workflowId: workflow.id, claimToken: "claim-one" },
      { action: "claim", workflowId: workflow.id, claimToken: "claim-two" },
    ]);
    const winner = raced.find((result) => result.claimed)!.claimToken as string;
    const loser = winner === "claim-one" ? "claim-two" : "claim-one";
    assert.equal(raced.filter((result) => result.claimed).length, 1);

    const claimed = store.require(workflow.id).nodes[0]!;
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.claimToken, winner);
    const eventCount = store.readEvents(workflow.id, { limit: 100 }).events.length;
    const replay = store.claimNode({ workflowId: workflow.id, nodeKey: "agent", claimToken: winner });
    assert.equal(replay!.attempt, 1);
    assert.equal(store.readEvents(workflow.id, { limit: 100 }).events.length, eventCount);

    assert.throws(
      () =>
        store.transitionNode({
          workflowId: workflow.id,
          nodeKey: "agent",
          claimToken: loser,
          status: "succeeded",
        }),
      WorkflowValidationError,
    );
    const completedNode = store.transitionNode({
      workflowId: workflow.id,
      nodeKey: "agent",
      claimToken: winner,
      status: "succeeded",
      result: { answer: 42 },
    });
    assert.deepEqual(completedNode.result, { answer: 42 });
    assert.ok(completedNode.completedAt);
    assert.throws(
      () =>
        store.transitionNode({
          workflowId: workflow.id,
          nodeKey: "agent",
          claimToken: winner,
          status: "failed",
        }),
      WorkflowTransitionError,
    );

    const completed = store.transitionWorkflow({
      workflowId: workflow.id,
      status: "succeeded",
      result: { answer: 42 },
    });
    assert.deepEqual(completed.result, { answer: 42 });
    assert.ok(completed.completedAt);
    assert.equal(store.readEvents(workflow.id, { limit: 100 }).events.at(-1)!.type, "workflow.succeeded");

    const abandoned = store.submit({ definition: singleAgentDefinition() }).workflow;
    const firstClaim = store.claimNode({
      workflowId: abandoned.id,
      nodeKey: "agent",
      claimToken: "abandoned",
      leaseMs: 10,
    });
    assert.equal(firstClaim!.attempt, 1);
    await delay(20);
    const recovered = store.claimNode({
      workflowId: abandoned.id,
      nodeKey: "agent",
      claimToken: "replacement",
    });
    assert.equal(recovered!.attempt, 2);
    assert.equal(recovered!.claimToken, "replacement");
    assert.equal(store.readEvents(abandoned.id, { limit: 100 }).events.at(-1)!.type, "node.reclaimed");
  } finally {
    store.close();
  }
}

function testTerminalInvariantsAndAtomicity(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  try {
    const workflow = store.submit({ definition: singleAgentDefinition() }).workflow;
    store.claimNode({ workflowId: workflow.id, nodeKey: "agent", claimToken: "claim" });
    assert.throws(
      () => store.transitionWorkflow({ workflowId: workflow.id, status: "succeeded" }),
      /Cannot succeed workflow while node agent is running/,
    );

    const beforeNodeFailure = store.require(workflow.id);
    const beforeNodeEvents = store.readEvents(workflow.id, { limit: 100 }).events;
    assert.throws(
      () =>
        store.transitionNode({
          workflowId: workflow.id,
          nodeKey: "agent",
          claimToken: "claim",
          status: "succeeded",
          result: { persisted: false },
          eventPayload: { body: "x".repeat(65_536) },
        }),
      WorkflowValidationError,
    );
    assert.deepEqual(store.require(workflow.id), beforeNodeFailure);
    assert.deepEqual(store.readEvents(workflow.id, { limit: 100 }).events, beforeNodeEvents);

    store.transitionNode({
      workflowId: workflow.id,
      nodeKey: "agent",
      claimToken: "claim",
      status: "succeeded",
    });
    const beforeWorkflowFailure = store.require(workflow.id);
    const beforeWorkflowEvents = store.readEvents(workflow.id, { limit: 100 }).events;
    assert.throws(
      () =>
        store.transitionWorkflow({
          workflowId: workflow.id,
          status: "succeeded",
          result: { persisted: false },
          eventPayload: { body: "x".repeat(65_536) },
        }),
      WorkflowValidationError,
    );
    assert.deepEqual(store.require(workflow.id), beforeWorkflowFailure);
    assert.deepEqual(store.readEvents(workflow.id, { limit: 100 }).events, beforeWorkflowEvents);

    const failedWorkflow = store.submit({ definition: singleAgentDefinition() }).workflow;
    store.claimNode({ workflowId: failedWorkflow.id, nodeKey: "agent", claimToken: "active" });
    const failed = store.transitionWorkflow({ workflowId: failedWorkflow.id, status: "failed" });
    assert.equal(failed.nodes[0]!.status, "cancelled");
    assert.throws(
      () =>
        store.transitionNode({
          workflowId: failed.id,
          nodeKey: "agent",
          claimToken: "active",
          status: "failed",
        }),
      /Cannot transition node after workflow reached terminal status/,
    );
  } finally {
    store.close();
  }
}

function testDagValidation(stateDir: string): void {
  const store = new WorkflowStore(stateDir);
  try {
    assert.throws(
      () =>
        store.submit({
          definition: { version: 1, nodes: [agentNode("same"), agentNode("same")], edges: [] },
        }),
      /Duplicate workflow node key/,
    );
    assert.throws(
      () =>
        store.submit({
          definition: {
            version: 1,
            nodes: [agentNode("one")],
            edges: [{ from: "one", to: "missing" }],
          },
        }),
      /missing node/,
    );
    assert.throws(
      () =>
        store.submit({
          definition: {
            version: 1,
            nodes: [agentNode("one"), agentNode("two")],
            edges: [
              { from: "one", to: "two" },
              { from: "two", to: "one" },
            ],
          },
        }),
      /contains a cycle/,
    );

    const dag = store.submit({
      definition: {
        version: 1,
        nodes: [agentNode("one"), agentNode("two"), agentNode("three")],
        edges: [
          { from: "one", to: "two" },
          { from: "one", to: "three" },
        ],
      },
    }).workflow;
    assert.deepEqual(Object.fromEntries(dag.nodes.map((node) => [node.key, node.status])), {
      one: "ready",
      three: "pending",
      two: "pending",
    });

    const nulKeys = store.submit({
      definition: {
        version: 1,
        nodes: [agentNode("a\0b"), agentNode("a"), agentNode("b\0c"), agentNode("c")],
        edges: [
          { from: "a\0b", to: "c" },
          { from: "a", to: "b\0c" },
        ],
      },
    }).workflow;
    assert.equal(nulKeys.edges.length, 2);
  } finally {
    store.close();
  }
}

async function testBoundedAndRepeatedWait(stateDir: string): Promise<void> {
  const orchestrator = new WorkflowOrchestrator(stateDir);
  const workerStore = new WorkflowStore(stateDir);
  try {
    const workflow = orchestrator.submit({ definition: singleAgentDefinition() });
    const timeoutStart = performance.now();
    const timedOut = await orchestrator.wait(workflow.id, { timeoutMs: 100, pollIntervalMs: 10 });
    const timeoutElapsed = performance.now() - timeoutStart;
    assert.equal(timedOut.status, "queued");
    assert.ok(timeoutElapsed >= 70, `bounded wait returned early after ${timeoutElapsed}ms`);
    assert.ok(timeoutElapsed < 500, `bounded wait took ${timeoutElapsed}ms`);

    const realDateNow = Date.now;
    const jumpTimer = setTimeout(() => {
      Date.now = () => realDateNow() + 60 * 60_000;
    }, 20);
    try {
      const jumpStart = performance.now();
      await orchestrator.wait(workflow.id, { timeoutMs: 100, pollIntervalMs: 10 });
      assert.ok(performance.now() - jumpStart >= 70, "wall-clock jump ended wait early");
    } finally {
      clearTimeout(jumpTimer);
      Date.now = realDateNow;
    }

    setTimeout(() => {
      workerStore.transitionWorkflow({ workflowId: workflow.id, status: "failed" });
    }, 15);
    const completed = await orchestrator.wait(workflow.id, { timeoutMs: 500, pollIntervalMs: 5 });
    assert.equal(completed.status, "failed");

    const repeatStart = performance.now();
    const repeated = await orchestrator.wait(workflow.id, { timeoutMs: 500, pollIntervalMs: 5 });
    assert.equal(repeated.status, "failed");
    assert.ok(performance.now() - repeatStart < 100);
  } finally {
    workerStore.close();
    orchestrator.close();
  }

  const closingOrchestrator = new WorkflowOrchestrator(`${stateDir}-closing`);
  const closingWorkflow = closingOrchestrator.submit({ definition: singleAgentDefinition() });
  const pendingWait = closingOrchestrator.wait(closingWorkflow.id, {
    timeoutMs: 500,
    pollIntervalMs: 50,
  });
  closingOrchestrator.close();
  assert.equal((await pendingWait).status, "queued");
  closingOrchestrator.close();
}

async function runWorker(spec: WorkerSpec): Promise<void> {
  const store = new WorkflowStore(spec.stateDir);
  try {
    writeFileSync(spec.readyPath, "ready");
    while (!existsSync(spec.barrierPath)) await delay(2);
    if (spec.action === "submit") {
      const input = spec.requestVariant === "b" ? { variant: "b" } : { variant: "a" };
      const request: SubmitWorkflowRequest = {
        definition: singleAgentDefinition(),
        input,
        idempotencyKey: spec.requestVariant === "same" ? "same-request" : "conflicting-request",
      };
      if (spec.requestVariant === "same") request.input = { variant: "same" };
      try {
        const result = store.submit(request);
        process.stdout.write(JSON.stringify({ workflowId: result.workflow.id, created: result.created }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: (error as Error).name }));
      }
      return;
    }
    if (spec.action === "claim") {
      const claimed = store.claimNode({
        workflowId: spec.workflowId!,
        nodeKey: "agent",
        claimToken: spec.claimToken!,
      });
      process.stdout.write(JSON.stringify({ claimed: Boolean(claimed), claimToken: spec.claimToken }));
      return;
    }
    for (let index = 0; index < spec.count!; index += 1) {
      const value = spec.start! + index;
      store.appendEvent(spec.workflowId!, `concurrent.${value}`, { value });
    }
    process.stdout.write(JSON.stringify({ appended: spec.count }));
  } finally {
    store.close();
  }
}

async function runWorkers(
  stateDir: string,
  workers: Array<Omit<WorkerSpec, "stateDir" | "readyPath" | "barrierPath">>,
): Promise<Array<Record<string, unknown>>> {
  const coordinationDir = mkdtempSync(join(tmpdir(), "devspace-workflow-race-"));
  const barrierPath = join(coordinationDir, "start");
  const running = workers.map((worker, index) => {
    const readyPath = join(coordinationDir, `ready-${index}`);
    const spec: WorkerSpec = { ...worker, stateDir, readyPath, barrierPath };
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), JSON.stringify(spec)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Workflow worker exited ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout) as Record<string, unknown>);
      });
    });
    return { readyPath, result };
  });
  try {
    const deadline = performance.now() + 10_000;
    while (running.some(({ readyPath }) => !existsSync(readyPath))) {
      if (performance.now() >= deadline) throw new Error("Timed out waiting for workflow workers");
      await delay(5);
    }
    writeFileSync(barrierPath, "start");
    return await Promise.all(running.map(({ result }) => result));
  } finally {
    rmSync(coordinationDir, { recursive: true, force: true });
  }
}

function assertDatabaseCounts(
  stateDir: string,
  expected: { runs: number; nodes: number; edges: number; events: number },
): void {
  const database = openDatabase(stateDir);
  try {
    assert.deepEqual(
      {
        runs: database.sqlite.prepare("select count(*) from workflow_runs").pluck().get(),
        nodes: database.sqlite.prepare("select count(*) from workflow_nodes").pluck().get(),
        edges: database.sqlite.prepare("select count(*) from workflow_edges").pluck().get(),
        events: database.sqlite.prepare("select count(*) from workflow_events").pluck().get(),
      },
      expected,
    );
  } finally {
    database.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function singleAgentDefinition(config: Record<string, string | boolean> = {}): WorkflowDefinitionV1 {
  return { version: 1, nodes: [{ key: "agent", type: "agent", config }], edges: [] };
}

function agentNode(key: string): WorkflowDefinitionV1["nodes"][number] {
  return { key, type: "agent", config: {} };
}
