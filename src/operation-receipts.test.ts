import assert from "node:assert/strict";
import test from "node:test";
import { OperationReceiptManager } from "./operation-receipts.js";

const op = (suffix: string) => `op-test-${suffix}`;

test("replays a completed operation without executing twice", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("completed"),
    tool: "write",
    request: { path: "a.txt", content: "hello" },
    execute: async () => ++executions,
  };
  assert.deepEqual(await manager.run(input), { value: 1, replayed: false });
  assert.deepEqual(await manager.run(input), { value: 1, replayed: true });
  assert.equal(executions, 1);
});

test("joins an in-flight duplicate", async () => {
  const manager = new OperationReceiptManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("inflight"),
    tool: "exec_command",
    request: { cmd: "slow" },
    execute: async () => { executions++; await gate; return 42; },
  };
  const first = manager.run(input);
  const second = manager.run(input);
  await Promise.resolve();
  assert.equal(executions, 1);
  release();
  assert.deepEqual(await first, { value: 42, replayed: false });
  assert.deepEqual(await second, { value: 42, replayed: true });
});

test("replays the same failure without repeating its side effect", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("failure"),
    tool: "bash",
    request: { command: "danger" },
    execute: async () => { executions++; throw new Error("failed after side effect"); },
  };
  await assert.rejects(manager.run(input), /failed after side effect/);
  await assert.rejects(manager.run(input), /failed after side effect/);
  assert.equal(executions, 1);
});

test("rejects reusing an operation id for a changed request", async () => {
  const manager = new OperationReceiptManager();
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("conflict"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "ok",
  });
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: op("conflict"),
    tool: "write",
    request: { content: "two" },
    execute: async () => "wrong",
  }), /different request/);
});

test("canonicalizes object key order", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("canonical"),
    tool: "edit",
    request: { a: 1, nested: { x: true, y: "z" } },
    execute: async () => ++executions,
  });
  const replay = await manager.run({
    workspaceId: "ws_1",
    operationId: op("canonical"),
    tool: "edit",
    request: { nested: { y: "z", x: true }, a: 1 },
    execute: async () => ++executions,
  });
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
});

test("compacts expired results to fail-closed tombstones", async () => {
  let now = 0;
  const manager = new OperationReceiptManager({ receiptTtlMs: 10, now: () => now });
  const input = {
    workspaceId: "ws_1",
    operationId: op("expired"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "ok",
  };
  await manager.run(input);
  now = 11;
  await assert.rejects(manager.run(input), /stored result has expired/);
});

test("fails closed instead of evicting live receipts", async () => {
  const manager = new OperationReceiptManager({ maxReceipts: 1 });
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("capacity1"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "ok",
  });
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: op("capacity2"),
    tool: "write",
    request: { content: "two" },
    execute: async () => "ok",
  }), /capacity reached/);
});

test("rejects malformed operation ids before execution", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: "bad",
    tool: "write",
    request: {},
    execute: async () => ++executions,
  }), /operationId must be/);
  assert.equal(executions, 0);
});
