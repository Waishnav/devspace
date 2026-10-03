import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiMcpBridgeExtension } from "./local-agent-pi-mcp.js";

const directory = await mkdtemp(join(process.cwd(), ".tmp-pi-mcp-"));
const script = join(directory, "mock-mcp.mjs");
await writeFile(script, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock-pi-mcp", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo",
    description: "Echo a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: "echo:" + String(request.params.arguments?.value ?? "") }],
}));
await server.connect(new StdioServerTransport());
`, "utf8");

const registered: any[] = [];
const handlers = new Map<string, (...args: any[]) => any>();
const extension = createPiMcpBridgeExtension({
  name: "devspace-agents-test",
  command: process.execPath,
  args: [script],
  env: {},
});
await extension({
  registerTool(tool: unknown) { registered.push(tool); },
  on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
} as never);

assert.equal(registered.length, 1);
assert.equal(registered[0]?.name, "mcp__devspace-agents-test__echo");
const result = await registered[0].execute(
  "call-1",
  { value: "hello" },
  new AbortController().signal,
);
assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);

const beforeAgentStart = handlers.get("before_agent_start");
assert.ok(beforeAgentStart);
assert.match(
  beforeAgentStart!({ systemPrompt: "base" }).systemPrompt,
  /DevSpace agent tools/,
);
await handlers.get("session_shutdown")?.({}, {});
await rm(directory, { recursive: true, force: true });
