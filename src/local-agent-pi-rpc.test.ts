import assert from "node:assert/strict";
import test from "node:test";
import { PiRpcConnection } from "./local-agent-pi-rpc.js";

const script = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    process.stdout.write("not-json\n");
    process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data: { echoed: request.value },
    }) + "\n");
  }
});
`;

test("responses resolve requests while other lines queue as events", async () => {
  const connection = PiRpcConnection.spawn({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
  });

  const response = await connection.request({ type: "echo", value: "hello" });
  assert.deepEqual(response, { echoed: "hello" });
  assert.deepEqual(await connection.nextEvent(1_000), { type: "agent_start" });
  connection.close();
});

// A Pi that writes a lot to stderr must not block on a full pipe, and a crash reports what it said.
test("a noisy stderr does not block and a crash reports what Pi said", async () => {
  const noisyScript = String.raw`
process.stderr.write("x".repeat(256 * 1024));
process.stderr.write("fatal: broken extension\n", () => process.exit(3));
`;

  const noisy = PiRpcConnection.spawn({
    command: process.execPath,
    args: ["-e", noisyScript],
    cwd: process.cwd(),
    env: process.env,
  });

  await assert.rejects(
    () => noisy.nextEvent(5_000),
    /exited with code 3[\s\S]*fatal: broken extension/,
  );
  assert.equal(noisy.isAlive(), false);
});

// Events nobody consumed (for example the tail of a cancelled turn) can be dropped.
test("unconsumed events can be cleared", async () => {
  const clearable = PiRpcConnection.spawn({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
  });

  await clearable.request({ type: "echo", value: "again" });
  clearable.clearEvents();
  assert.equal(await clearable.nextEvent(100), undefined);
  clearable.close();
});
