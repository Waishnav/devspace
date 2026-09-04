import assert from "node:assert/strict";
import test from "node:test";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
} from "./mcp-modern-server.js";

test("strict modern handler answers the 2026-07-28 discovery probe", async (t) => {
  const handler = createMcpHandler(() => new McpServer(
    { name: "devspace-modern-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ), { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("server/discover", {}));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: { supportedVersions?: string[] };
  };
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
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "echo_scope"));

  const called = await handler.fetch(modernRequest("tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  }));
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
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
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  assert.ok(messages.some((message) => message.method === "notifications/progress"));
  assert.match(JSON.stringify(messages.at(-1)), /done/);
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

function modernRequest(method: string, params: Record<string, unknown>): Request {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
