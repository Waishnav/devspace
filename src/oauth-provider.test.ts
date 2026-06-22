import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOAuthStore } from "./oauth-provider.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));

try {
  const first = new SqliteOAuthStore(root, ["chatgpt.com"]);
  const client = first.registerClient({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  first.saveToken("access-token", "access", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt,
    resource: new URL("https://devspace.example.com/mcp"),
  });
  first.saveToken("refresh-token", "refresh", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt,
  });
  first.close();

  const second = new SqliteOAuthStore(root, ["chatgpt.com"]);
  assert.deepEqual(second.getClient(client.client_id), client);
  assert.deepEqual(second.getToken("access-token", "access"), {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt,
    resource: new URL("https://devspace.example.com/mcp"),
  });
  assert.deepEqual(second.getToken("refresh-token", "refresh"), {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt,
    resource: undefined,
  });
  second.deleteToken("refresh-token");
  assert.equal(second.getToken("refresh-token", "refresh"), undefined);
  second.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
