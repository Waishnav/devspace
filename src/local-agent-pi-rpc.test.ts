import assert from "node:assert/strict";
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
