import assert from "node:assert/strict";
import test from "node:test";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { ResourceTemplate as LegacyResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
} from "./mcp-modern-server.js";

const modernDiscoveryBody = z.object({
  result: z.object({ supportedVersions: z.array(z.string()) }).optional(),
});

const modernListBody = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })).optional() }).optional(),
});

const modernCallBody = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string().optional() })).optional() }).optional(),
});

const modernStreamMessage = z.object({
  method: z.string().optional(),
  result: z.object({
    content: z.array(z.object({ text: z.string().optional() })).optional(),
  }).optional(),
});

const modernParams = z.object({
  name: z.string().optional(),
  uri: z.string().optional(),
  arguments: z.record(z.string(), z.string()).optional(),
  _meta: z.object({
    "openai/session": z.string().optional(),
    progressToken: z.string().optional(),
  }).optional(),
});

type ModernParams = z.infer<typeof modernParams>;

test("strict modern handler answers the 2026-07-28 discovery probe", async (t) => {
  const handler = createMcpHandler(() => new McpServer(
    { name: "devspace-modern-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ), { legacy: "reject" });

  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("server/discover", {}));

  assert.equal(response.status, 200);

  const body = modernDiscoveryBody.parse(await response.json());

  assert.ok(body.result?.supportedVersions?.includes("2026-07-28"));
});

test("modern registration adapter preserves tools and request metadata", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    registerAppTool(
      adapter.registrationTarget,
      "echo_scope",
      {
        description: "Echo the modern request scope.",
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }, { _meta }) => ({
        content: [{
          type: "text",
          text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const listed = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(listed.status, 200);

  const listBody = modernListBody.parse(await listed.json());

  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "echo_scope"));

  const called = await handler.fetch(modernRequest("tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  }));

  assert.equal(called.status, 200, await called.clone().text());

  const callBody = modernCallBody.parse(await called.json());

  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
});

test("modern registration adapter preserves zero-input tool context", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    registerAppTool(
      adapter.registrationTarget,
      "session_scope",
      { _meta: {} },
      async ({ _meta }) => ({
        content: [{ type: "text", text: String(_meta?.["openai/session"] ?? "missing") }],
      }),
    );

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("tools/call", {
    name: "session_scope",
    _meta: { "openai/session": "zero-input-chat" },
  }));

  assert.equal(response.status, 200, await response.clone().text());

  const body = modernCallBody.parse(await response.json());

  assert.equal(body.result?.content?.[0]?.text, "zero-input-chat");
});

test("modern registration adapter preserves progress notifications", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    registerAppTool(
      adapter.registrationTarget,
      "progress_echo",
      {
        inputSchema: {},
        _meta: {},
      },
      async (_input, { sendNotification }) => {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: "modern-progress",
            progress: 1,
            total: 1,
          },
        });

        return { content: [{ type: "text", text: "done" }] };
      },
    );

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("tools/call", {
    name: "progress_echo",
    arguments: {},
    _meta: { progressToken: "modern-progress" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const messages = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => modernStreamMessage.parse(JSON.parse(line.slice(6))));

  assert.ok(messages.some((message) => message.method === "notifications/progress"));
  assert.equal(messages.at(-1)?.result?.content?.[0]?.text, "done");
});

test("modern registration adapter preserves resources", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    registerAppResource(
      adapter.registrationTarget,
      "Test resource",
      "ui://devspace/test.html",
      {},
      async (_uri, { _meta }) => ({
        contents: [{
          uri: "ui://devspace/test.html",
          mimeType: "text/html",
          text: `resource-ok:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://devspace/test.html",
    _meta: { "openai/session": "resource-chat" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /resource-ok:resource-chat/);
});

test("modern registration adapter preserves resource templates", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    adapter.registrationTarget.registerResource(
      "Templated resource",
      new LegacyResourceTemplate("ui://devspace/{name}.html", { list: undefined }),
      {},
      async (uri, variables, { _meta }) => ({
        contents: [{
          uri: uri.href,
          mimeType: "text/html",
          text: `template-ok:${String(variables.name)}:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://devspace/test.html",
    _meta: { "openai/session": "template-chat" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /template-ok:test:template-chat/);
});

test("compiled registration surface reuses static tool and resource definitions", async (t) => {
  let registrationBuilds = 0;

  const bindRegistrationSurface = compileMcpRegistrationSurface((target) => {
    registrationBuilds += 1;
    registerAppTool(
      target,
      "cached_echo",
      {
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
      }),
    );
    registerAppResource(
      target,
      "Cached resource",
      "ui://devspace/cached.html",
      {},
      async () => ({
        contents: [{
          uri: "ui://devspace/cached.html",
          mimeType: "text/html",
          text: "cached-resource",
        }],
      }),
    );
  });

  assert.equal(registrationBuilds, 1);

  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });

    bindRegistrationSurface(adapter.registrationTarget);

    return adapter.server;
  }, { legacy: "reject" });

  t.after(async () => handler.close());

  const firstList = await handler.fetch(modernRequest("tools/list", {}));
  const secondList = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(firstList.status, 200, await firstList.clone().text());
  assert.equal(secondList.status, 200, await secondList.clone().text());
  assert.equal(registrationBuilds, 1);

  const resource = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://devspace/cached.html",
  }));

  assert.equal(resource.status, 200, await resource.clone().text());
  assert.match(await resource.text(), /cached-resource/);
  assert.equal(registrationBuilds, 1);
});

test("modern adapter error logging preserves error and cause identity", () => {
  const fields = modernMcpAdapterErrorLogFields(
    new Error("outer failure", { cause: new TypeError("inner failure") }),
  );

  assert.deepEqual(fields, {
    error: "outer failure",
    errorName: "Error",
    cause: {
      name: "TypeError",
      message: "inner failure",
    },
  });
});

function modernRequest(method: string, params: ModernParams): Request {
  const mcpName = params.name ?? params.uri;

  const headers = {
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };

  const requestHeaders = mcpName === undefined ? headers : { ...headers, "mcp-name": mcpName };

  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          "openai/session": params._meta?.["openai/session"],
          progressToken: params._meta?.progressToken,
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}
