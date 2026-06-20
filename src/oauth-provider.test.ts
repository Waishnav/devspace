import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const root = mkdtempSync(join(tmpdir(), "devspace-oauth-provider-test-"));
const statePath = join(root, "oauth.json");
const resourceServerUrl = new URL("https://devspace.example.com/mcp");
const config: OAuthConfig = {
  ownerToken: "owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["localhost"],
  statePath,
};

try {
  const firstProvider = new SingleUserOAuthProvider(config, resourceServerUrl);
  const client = firstProvider.clientsStore.registerClient({
    client_name: "test client",
    redirect_uris: ["http://localhost/callback"],
    scope: "devspace",
  });
  const issueTokens = firstProvider["issueTokens"] as (
    clientId: string,
    scopes: string[],
    resource?: URL,
  ) => OAuthTokens;
  const firstTokens = issueTokens.call(firstProvider, client.client_id, ["devspace"], resourceServerUrl);

  const savedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(savedState.clients.length, 1);
  assert.equal(savedState.accessTokens, undefined);
  assert.equal(savedState.refreshTokens.length, 1);
  assert.equal(savedState.refreshTokens[0].token, undefined);
  assert.equal(savedState.refreshTokens[0].resource, resourceServerUrl.href);

  const secondProvider = new SingleUserOAuthProvider(config, resourceServerUrl);
  const persistedClient = secondProvider.clientsStore.getClient(client.client_id);
  assert.equal(persistedClient?.client_id, client.client_id);

  await assert.rejects(
    () => secondProvider.verifyAccessToken(firstTokens.access_token),
    InvalidTokenError,
  );

  const secondTokens = await secondProvider.exchangeRefreshToken(
    client,
    assertString(firstTokens.refresh_token),
    undefined,
    resourceServerUrl,
  );
  assert.equal(Boolean(secondTokens.refresh_token), true);
  assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);

  const rotatedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(rotatedState.clients.length, 1);
  assert.equal(rotatedState.accessTokens, undefined);
  assert.equal(rotatedState.refreshTokens.length, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assertString(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}
