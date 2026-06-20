import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-store-test-"));
const stateDir = join(root, "state");
const resource = new URL("https://example.test/mcp");
const redirectUri = "http://localhost/callback";
const config = {
  ownerToken: "test-owner-password-long-enough",
  accessTokenTtlSeconds: 60,
  refreshTokenTtlSeconds: 120,
  scopes: ["devspace"],
  allowedRedirectHosts: ["localhost"],
};

try {
  const firstProvider = new SingleUserOAuthProvider(config, resource, stateDir);
  const registerClient = firstProvider.clientsStore.registerClient;
  assert.ok(registerClient);

  const client = await registerClient.call(firstProvider.clientsStore, {
    client_name: "Persistent OAuth test client",
    redirect_uris: [redirectUri],
  });
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(config, resource, stateDir);
  assert.deepEqual(await secondProvider.clientsStore.getClient(client.client_id), client);
  secondProvider.close();

  const firstStore = new SqliteOAuthStore(stateDir);
  const authorizationCode = "authorization-code-value";
  const accessToken = "access-token-value";
  const refreshToken = "refresh-token-value";
  const authorizationCodeHash = hashValue(authorizationCode);
  const accessTokenHash = hashValue(accessToken);
  const refreshTokenHash = hashValue(refreshToken);
  const now = Math.floor(Date.now() / 1000);

  firstStore.saveAuthorizationCode(authorizationCodeHash, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge-value",
      scopes: ["devspace"],
      resource,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  firstStore.saveAccessToken(accessTokenHash, {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now + 60,
    resource,
  });
  firstStore.saveRefreshToken(refreshTokenHash, {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now + 120,
    resource,
  });
  firstStore.close();

  const secondStore = new SqliteOAuthStore(stateDir);
  assert.equal(secondStore.getAuthorizationCode(authorizationCodeHash)?.clientId, client.client_id);
  assert.equal(
    secondStore.getAuthorizationCode(authorizationCodeHash)?.params.resource?.href,
    resource.href,
  );
  assert.equal(secondStore.getAccessToken(accessTokenHash)?.clientId, client.client_id);
  assert.equal(secondStore.getAccessToken(accessTokenHash)?.resource?.href, resource.href);
  assert.equal(secondStore.getRefreshToken(refreshTokenHash)?.clientId, client.client_id);
  assert.equal(secondStore.getRefreshToken(refreshTokenHash)?.resource?.href, resource.href);

  secondStore.saveAuthorizationCode("expired-code-hash", {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "expired-challenge",
      scopes: ["devspace"],
      resource,
    },
    expiresAtMs: Date.now() - 1,
  });
  secondStore.saveAccessToken("expired-access-hash", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now - 1,
  });
  secondStore.saveRefreshToken("expired-refresh-hash", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now - 1,
  });
  assert.equal(secondStore.getAuthorizationCode("expired-code-hash"), undefined);
  assert.equal(secondStore.getAccessToken("expired-access-hash"), undefined);
  assert.equal(secondStore.getRefreshToken("expired-refresh-hash"), undefined);

  secondStore.saveAccessToken("shared-hash", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now + 60,
  });
  secondStore.saveRefreshToken("shared-hash", {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now + 60,
  });
  secondStore.revokeToken("shared-hash");
  assert.equal(secondStore.getAccessToken("shared-hash"), undefined);
  assert.equal(secondStore.getRefreshToken("shared-hash"), undefined);
  secondStore.close();

  const database = openDatabase(stateDir);
  try {
    const storedCode = database.sqlite
      .prepare("select code_hash from oauth_authorization_codes where code_hash = ?")
      .get(authorizationCodeHash) as { code_hash: string } | undefined;
    const storedTokens = database.sqlite
      .prepare("select token_hash from oauth_tokens where token_hash in (?, ?)")
      .all(accessTokenHash, refreshTokenHash) as Array<{ token_hash: string }>;

    assert.equal(storedCode?.code_hash, authorizationCodeHash);
    assert.notEqual(storedCode?.code_hash, authorizationCode);
    assert.equal(storedTokens.some((row) => row.token_hash === accessToken), false);
    assert.equal(storedTokens.some((row) => row.token_hash === refreshToken), false);
  } finally {
    database.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
