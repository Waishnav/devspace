import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const root = mkdtempSync(join(tmpdir(), "devspace-oauth-provider-test-"));
const statePath = join(root, "state", "oauth.json");
const customStatePath = join(root, "custom", "oauth-state.json");
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
  const firstTokens = issueTokens(firstProvider, client.client_id, ["devspace"], resourceServerUrl);

  const savedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(savedState.clients.length, 1);
  assert.equal(savedState.accessTokens.length, 1);
  assert.equal(savedState.accessTokens[0].tokenHash.length > 0, true);
  assert.equal(savedState.accessTokens[0].token, undefined);
  assert.equal(savedState.refreshTokens.length, 1);
  assert.equal(savedState.refreshTokens[0].tokenHash.length > 0, true);
  assert.equal(savedState.refreshTokens[0].token, undefined);
  assert.equal(JSON.stringify(savedState).includes(assertString(firstTokens.access_token)), false);
  assert.equal(JSON.stringify(savedState).includes(assertString(firstTokens.refresh_token)), false);

  const stateStats = await stat(statePath);
  const dirStats = await stat(join(root, "state"));
  assert.equal(stateStats.mode & 0o777, 0o600);
  assert.equal(dirStats.mode & 0o777, 0o700);

  const secondProvider = new SingleUserOAuthProvider(config, resourceServerUrl);
  const persistedClient = secondProvider.clientsStore.getClient(client.client_id);
  assert.equal(persistedClient?.client_id, client.client_id);

  const persistedAccess = await secondProvider.verifyAccessToken(assertString(firstTokens.access_token));
  assert.equal(persistedAccess.clientId, client.client_id);
  assert.deepEqual(persistedAccess.scopes, ["devspace"]);
  assert.equal(persistedAccess.resource?.href, resourceServerUrl.href);

  const secondTokens = await secondProvider.exchangeRefreshToken(
    client,
    assertString(firstTokens.refresh_token),
    undefined,
    resourceServerUrl,
  );
  assert.equal(Boolean(secondTokens.refresh_token), true);
  assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);

  const rotatedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(rotatedState.refreshTokens.length, 1);
  assert.equal(rotatedState.accessTokens.length, 2);
  assert.equal(JSON.stringify(rotatedState).includes(assertString(firstTokens.access_token)), false);
  assert.equal(JSON.stringify(rotatedState).includes(assertString(firstTokens.refresh_token)), false);
  await assert.rejects(
    () => secondProvider.exchangeRefreshToken(client, assertString(firstTokens.refresh_token), undefined, resourceServerUrl),
    InvalidGrantError,
  );

  const expiredStatePath = join(root, "expired", "oauth.json");
  mkdirSync(join(root, "expired"), { recursive: true });
  writeFileSync(
    expiredStatePath,
    JSON.stringify({
      version: 1,
      clients: [client],
      accessTokens: [{
        tokenHash: "expired-access-token-hash",
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: 1,
        resource: resourceServerUrl.href,
      }],
      refreshTokens: [{
        tokenHash: "expired-token-hash",
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: 1,
        resource: resourceServerUrl.href,
      }],
    }),
  );
  await chmod(expiredStatePath, 0o600);
  const expiredProvider = new SingleUserOAuthProvider({ ...config, statePath: expiredStatePath }, resourceServerUrl);
  await assert.rejects(
    () => expiredProvider.exchangeRefreshToken(client, assertString(firstTokens.refresh_token), undefined, resourceServerUrl),
    InvalidGrantError,
  );
  const cleanedExpiredState = JSON.parse(readFileSync(expiredStatePath, "utf8"));
  assert.equal(cleanedExpiredState.accessTokens.length, 0);
  assert.equal(cleanedExpiredState.refreshTokens.length, 0);

  const corruptStatePath = join(root, "corrupt", "oauth.json");
  mkdirSync(join(root, "corrupt"), { recursive: true });
  writeFileSync(corruptStatePath, "{not valid json");
  await chmod(corruptStatePath, 0o600);
  const corruptProvider = new SingleUserOAuthProvider({ ...config, statePath: corruptStatePath }, resourceServerUrl);
  assert.equal(corruptProvider.clientsStore.getClient(client.client_id), undefined);
  const repairedState = JSON.parse(readFileSync(corruptStatePath, "utf8"));
  assert.deepEqual(repairedState, { version: 1, clients: [], accessTokens: [], refreshTokens: [] });

  const emptyStatePath = join(root, "empty", "oauth.json");
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(emptyStatePath, "");
  await chmod(emptyStatePath, 0o600);
  const emptyProvider = new SingleUserOAuthProvider({ ...config, statePath: emptyStatePath }, resourceServerUrl);
  assert.equal(emptyProvider.clientsStore.getClient(client.client_id), undefined);
  const rewrittenEmptyState = JSON.parse(readFileSync(emptyStatePath, "utf8"));
  assert.deepEqual(rewrittenEmptyState, { version: 1, clients: [], accessTokens: [], refreshTokens: [] });

  const customProvider = new SingleUserOAuthProvider({ ...config, statePath: customStatePath }, resourceServerUrl);
  customProvider.clientsStore.registerClient({
    client_name: "custom state client",
    redirect_uris: ["http://localhost/custom"],
    scope: "devspace",
  });
  assert.equal(JSON.parse(readFileSync(customStatePath, "utf8")).clients.length, 1);

  const expiredAccessStatePath = join(root, "expired-access", "oauth.json");
  mkdirSync(join(root, "expired-access"), { recursive: true });
  const expiredAccessTokens = issueTokens(firstProvider, client.client_id, ["devspace"], resourceServerUrl);
  writeFileSync(
    expiredAccessStatePath,
    JSON.stringify({
      version: 1,
      clients: [client],
      accessTokens: [{
        tokenHash: hashTestToken(assertString(expiredAccessTokens.access_token)),
        clientId: client.client_id,
        scopes: ["devspace"],
        expiresAt: 1,
        resource: resourceServerUrl.href,
      }],
      refreshTokens: [],
    }),
  );
  await chmod(expiredAccessStatePath, 0o600);
  const expiredAccessProvider = new SingleUserOAuthProvider(
    { ...config, statePath: expiredAccessStatePath },
    resourceServerUrl,
  );
  await assert.rejects(
    () => expiredAccessProvider.verifyAccessToken(assertString(expiredAccessTokens.access_token)),
    InvalidTokenError,
  );
  const cleanedExpiredAccessState = JSON.parse(readFileSync(expiredAccessStatePath, "utf8"));
  assert.equal(cleanedExpiredAccessState.accessTokens.length, 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function issueTokens(
  provider: SingleUserOAuthProvider,
  clientId: string,
  scopes: string[],
  resource?: URL,
): OAuthTokens {
  const rawIssueTokens = provider["issueTokens"] as (
    currentClientId: string,
    currentScopes: string[],
    currentResource?: URL,
  ) => OAuthTokens;
  return rawIssueTokens.call(provider, clientId, scopes, resource);
}

function assertString(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}

function hashTestToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
