import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { ClientAccessConfig } from "./client-access.js";
import { handleClientAccessInitialize } from "./server.js";

const config: ClientAccessConfig = {
  mode: "enforce",
  deniedClients: ["codex"],
};

const app = express();
app.use(express.json());

let continuedRequests = 0;
app.post("/mcp", (req, res) => {
  assert.equal(isInitializeRequest(req.body), true);
  const { clientAccess } = handleClientAccessInitialize(res, req.body, config);
  if (!clientAccess.allowed) return;

  continuedRequests += 1;
  res.sendStatus(204);
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const deniedResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.145.0" },
      },
    }),
  });

  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), {
    jsonrpc: "2.0",
    error: { code: -32003, message: "MCP client not allowed" },
    id: 0,
  });
  assert.equal(continuedRequests, 0);

  const allowedResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "", version: "" },
      },
    }),
  });

  assert.equal(allowedResponse.status, 204);
  assert.equal(continuedRequests, 1);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
