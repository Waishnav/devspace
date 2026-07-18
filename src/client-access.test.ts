import assert from "node:assert/strict";
import {
  evaluateClientAccess,
  extractDeclaredClient,
  type ClientAccessConfig,
} from "./client-access.js";

const enforceCodexDenylist: ClientAccessConfig = {
  mode: "enforce",
  deniedClients: ["codex"],
};

assert.deepEqual(
  extractDeclaredClient({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-mcp-client",
        title: "Codex",
        version: "0.108.0-alpha.12",
      },
    },
  }),
  {
    name: "codex-mcp-client",
    title: "Codex",
    version: "0.108.0-alpha.12",
    identities: ["codex-mcp-client", "codex"],
  },
);

assert.deepEqual(
  evaluateClientAccess(enforceCodexDenylist, {
    name: "codex-mcp-client",
    title: "Codex",
    version: "0.145.0",
    identities: ["codex-mcp-client", "codex"],
  }),
  {
    allowed: false,
    reason: "denied_client",
    matchedClient: "codex",
  },
);

assert.deepEqual(
  evaluateClientAccess(enforceCodexDenylist, undefined),
  {
    allowed: true,
    reason: "allowed",
  },
);

assert.equal(extractDeclaredClient({ method: "tools/list", params: {} }), undefined);
assert.equal(
  extractDeclaredClient({ method: "initialize", params: { clientInfo: { name: "" } } }),
  undefined,
);
