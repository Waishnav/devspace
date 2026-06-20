import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { PersistentOAuthClientsStore, SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";

const dir = mkdtempSync(join(tmpdir(), "devspace-oauth-clients-"));

try {
  const filePath = join(dir, "oauth-clients.json");
  const firstStore = new PersistentOAuthClientsStore(["chatgpt.com"], filePath);
  const client = firstStore.registerClient({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
  });

  assert.equal(statSync(filePath).mode & 0o777, 0o600);

  const secondStore = new PersistentOAuthClientsStore(["chatgpt.com"], filePath);
  assert.deepEqual(secondStore.getClient(client.client_id), client);

  const mcpUrl = new URL("http://127.0.0.1:7766/mcp");
  const refreshToken = "test-refresh-token-that-is-long-enough";
  const refreshTokensPath = join(dir, "oauth-refresh-tokens.json");
  const oauthClient: OAuthClientInformationFull = {
    client_id: "devspace-test-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  const config: OAuthConfig = {
    ownerToken: "test-owner-token-that-is-long-enough",
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 3600,
    scopes: ["devspace"],
    allowedRedirectHosts: ["chatgpt.com"],
    clientsStorePath: join(dir, "provider-clients.json"),
    refreshTokensPath,
  };
  writeFileSync(
    refreshTokensPath,
    JSON.stringify([
      {
        key: createHash("sha256").update(refreshToken).digest("base64url"),
        clientId: oauthClient.client_id,
        scopes: ["devspace"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: mcpUrl.href,
      },
    ]),
    { mode: 0o600 },
  );

  const provider = new SingleUserOAuthProvider(config, mcpUrl);
  const tokens = await provider.exchangeRefreshToken(oauthClient, refreshToken, undefined, mcpUrl);
  assert.equal(tokens.token_type, "bearer");
  assert.match(tokens.refresh_token ?? "", /^[-_a-zA-Z0-9]+$/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
