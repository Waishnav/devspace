import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./codex-app-server.js";
import { CodexMcpClient } from "./codex-mcp-client.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-codex-"));
const fakeServerPath = join(temporaryDirectory, "fake-app-server.mjs");

const fakeServerSource = String.raw`
import readline from "node:readline";

const handles = new Set();
let pendingToolCall = null;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function childOutput(handle, message) {
  const data = Buffer.from(JSON.stringify(message) + "\n").toString("base64");
  send({
    method: "process/outputDelta",
    params: { processHandle: handle, stream: "stdout", deltaBase64: data, capReached: false },
  });
}

for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: "/tmp/fake-codex" } });
    continue;
  }
  if (message.method === "process/spawn") {
    handles.add(message.params.processHandle);
    send({ id: message.id, result: {} });
    continue;
  }
  if (message.method === "process/kill") {
    handles.delete(message.params.processHandle);
    send({ id: message.id, result: {} });
    send({
      method: "process/exited",
      params: {
        processHandle: message.params.processHandle,
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutCapReached: false,
        stderrCapReached: false,
      },
    });
    continue;
  }
  if (message.method === "process/writeStdin") {
    const handle = message.params.processHandle;
    const childMessage = JSON.parse(Buffer.from(message.params.deltaBase64, "base64").toString("utf8"));
    send({ id: message.id, result: {} });
    if (!handles.has(handle)) continue;

    if (childMessage.method === "initialize") {
      childOutput(handle, {
        jsonrpc: "2.0",
        id: childMessage.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake", version: "1" },
        },
      });
      continue;
    }
    if (childMessage.method === "tools/list") {
      childOutput(handle, {
        jsonrpc: "2.0",
        id: childMessage.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
      continue;
    }
    if (childMessage.method === "tools/call") {
      pendingToolCall = { handle, id: childMessage.id, arguments: childMessage.params.arguments };
      childOutput(handle, {
        jsonrpc: "2.0",
        id: "approval-1",
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Allow fake tool?",
          requestedSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      });
      continue;
    }
    if (childMessage.id === "approval-1" && pendingToolCall != null) {
      const accepted = childMessage.result?.action === "accept";
      childOutput(pendingToolCall.handle, {
        jsonrpc: "2.0",
        id: pendingToolCall.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ accepted, arguments: pendingToolCall.arguments }) },
          ],
          isError: false,
        },
      });
      pendingToolCall = null;
    }
  }
}
`;

try {
  await writeFile(fakeServerPath, fakeServerSource, "utf8");
  await chmod(fakeServerPath, 0o700);

  const observedMethods: string[] = [];
  const spawnImpl = ((
    _command: string,
    _args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => spawn(process.execPath, [fakeServerPath], options)) as typeof spawn;
  const appServer = new CodexAppServerClient({
    executable: fakeServerPath,
    cwd: temporaryDirectory,
    spawnImpl,
    onMethod: (method) => observedMethods.push(method),
  });

  await appServer.start();
  await assert.rejects(
    () => appServer.request("thread/start", {}),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "codex_app_server_method_forbidden"
    ),
  );
  await assert.rejects(
    () => appServer.request("turn/start", {}),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "codex_app_server_method_forbidden"
    ),
  );

  const child = await appServer.spawnProcess({
    command: ["fake-mcp"],
    cwd: temporaryDirectory,
  });
  const mcp = new CodexMcpClient(child, { name: "test", version: "1" });
  await mcp.start();
  const tools = await mcp.listTools();
  assert.equal(tools[0]?.name, "echo");

  let elicitationCount = 0;
  const result = await mcp.callTool(
    "echo",
    { value: "hello" },
    {
      onElicitation: async () => {
        elicitationCount += 1;
        return { action: "accept", content: {} };
      },
    },
  );
  assert.equal(result.isError, false);
  assert.equal(elicitationCount, 1);
  assert.match(
    result.content.find((item) => item.type === "text")?.text ?? "",
    /"accepted":true/u,
  );
  assert.deepEqual(
    Array.from(new Set(observedMethods)).sort(),
    ["initialize", "process/spawn", "process/writeStdin"].sort(),
  );
  assert.equal(observedMethods.includes("thread/start"), false);
  assert.equal(observedMethods.includes("turn/start"), false);

  await mcp.close();
  await appServer.close();
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
