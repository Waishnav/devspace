import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessDeniedError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-grace-test-"));
const baseConfig: OAuthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace", "read"],
  allowedResourceUrls: ["https://tunnel.example.com/v1/mcp/tunnel_123"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const serverUrl = new URL("https://agent.example.com/mcp");
const resource = new URL(baseConfig.allowedResourceUrls[0]!);
const otherResource = new URL("https://other.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const realDateNow = Date.now;

try {
  await testDefaultAndZeroGrace();
  await testConcurrentReuseAndRestartPersistence();
  await testGraceExpiryAndOriginalTtl();
  await testGraceDoesNotRelaxRefreshPolicy();
} finally {
  Date.now = realDateNow;
  await rm(root, { recursive: true, force: true });
}

async function testDefaultAndZeroGrace(): Promise<void> {
  const defaultDir = join(root, "default");
  const zeroDir = join(root, "zero");
  for (const [stateDir, config] of [[defaultDir, baseConfig], [zeroDir, { ...baseConfig, refreshTokenGraceSeconds: 0 }]] as const) {
    const provider = new SingleUserOAuthProvider(config, serverUrl, stateDir);
    try {
      const { client, tokens } = await issueInitialTokens(provider);
      const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token);
      await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), InvalidGrantError);
      assert.ok(rotated.refresh_token);
    } finally {
      provider.close();
    }
  }
}

async function testConcurrentReuseAndRestartPersistence(): Promise<void> {
  const stateDir = join(root, "concurrent-restart");
  const config = { ...baseConfig, refreshTokenGraceSeconds: 600 };
  const baseSeconds = 2_000_000_500;
  setNowSeconds(baseSeconds);
  try {
    const first = new SingleUserOAuthProvider(config, serverUrl, stateDir);
    const { client, tokens } = await issueInitialTokens(first);
    first.close();

    setNowSeconds(baseSeconds + 20);
    const left = new SingleUserOAuthProvider(config, serverUrl, stateDir);
    const right = new SingleUserOAuthProvider(config, serverUrl, stateDir);
    try {
      const [leftTokens, rightTokens] = await Promise.all([
        left.exchangeRefreshToken(client, tokens.refresh_token),
        right.exchangeRefreshToken(client, tokens.refresh_token),
      ]);
      assert.ok(leftTokens.refresh_token);
      assert.ok(rightTokens.refresh_token);
      assert.notEqual(leftTokens.refresh_token, rightTokens.refresh_token);
    } finally {
      left.close();
      right.close();
    }

    const reopened = new SingleUserOAuthProvider(config, serverUrl, stateDir);
    try {
      assert.equal(readRefreshExpiry(stateDir, tokens.refresh_token), baseSeconds + 20 + 600);
      const retried = await reopened.exchangeRefreshToken(client, tokens.refresh_token);
      assert.ok(retried.refresh_token);
      assert.equal((await reopened.verifyAccessToken(retried.access_token)).clientId, client.client_id);
      await reopened.revokeToken(client, { token: retried.refresh_token });
      await assert.rejects(reopened.exchangeRefreshToken(client, retried.refresh_token), InvalidGrantError);

      setNowSeconds(baseSeconds + 20 + 600);
      const atBoundary = await reopened.exchangeRefreshToken(client, tokens.refresh_token);
      assert.ok(atBoundary.refresh_token, "the 600-second grace token is accepted at its exact expiry second");
      setNowSeconds(baseSeconds + 20 + 601);
      await assert.rejects(reopened.exchangeRefreshToken(client, tokens.refresh_token), InvalidGrantError);
    } finally {
      reopened.close();
    }
  } finally {
    Date.now = realDateNow;
  }
}

async function testGraceExpiryAndOriginalTtl(): Promise<void> {
  const stateDir = join(root, "expiry");
  const config = { ...baseConfig, refreshTokenGraceSeconds: 10, refreshTokenTtlSeconds: 30 };
  const baseSeconds = 2_000_000_000;
  setNowSeconds(baseSeconds);
  const provider = new SingleUserOAuthProvider(config, serverUrl, stateDir);
  try {
    const { client, tokens } = await issueInitialTokens(provider);
    const oldExpiry = baseSeconds + 30;
    assert.equal((await provider.verifyAccessToken(tokens.access_token)).expiresAt, baseSeconds + 3600);
    assert.equal(readRefreshExpiry(stateDir, tokens.refresh_token), oldExpiry);

    setNowSeconds(baseSeconds + 5);
    const firstRotation = await provider.exchangeRefreshToken(client, tokens.refresh_token);
    assert.equal(readRefreshExpiry(stateDir, tokens.refresh_token), baseSeconds + 15);
    const firstNewRefreshExpiry = readRefreshExpiry(stateDir, firstRotation.refresh_token!);
    assert.equal(firstNewRefreshExpiry, baseSeconds + 5 + 30);
    assert.equal((await provider.verifyAccessToken(firstRotation.access_token)).expiresAt, baseSeconds + 5 + 3600);

    setNowSeconds(baseSeconds + 9);
    const secondRotation = await provider.exchangeRefreshToken(client, tokens.refresh_token);
    assert.equal(readRefreshExpiry(stateDir, tokens.refresh_token), baseSeconds + 15);
    assert.equal(readRefreshExpiry(stateDir, secondRotation.refresh_token!), baseSeconds + 9 + 30);

    setNowSeconds(baseSeconds + 15);
    const atBoundary = await provider.exchangeRefreshToken(client, tokens.refresh_token);
    assert.ok(atBoundary.refresh_token, "the grace token is accepted at its exact expiry second");
    assert.equal(readRefreshExpiry(stateDir, tokens.refresh_token), baseSeconds + 15);

    setNowSeconds(baseSeconds + 16);
    await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), InvalidGrantError);
  } finally {
    provider.close();
    Date.now = realDateNow;
  }

  const shortTtlDir = join(root, "short-original-ttl");
  const shortTtlConfig = { ...baseConfig, refreshTokenGraceSeconds: 10, refreshTokenTtlSeconds: 6 };
  setNowSeconds(baseSeconds);
  const shortTtlProvider = new SingleUserOAuthProvider(shortTtlConfig, serverUrl, shortTtlDir);
  try {
    const { client, tokens } = await issueInitialTokens(shortTtlProvider);
    assert.equal(readRefreshExpiry(shortTtlDir, tokens.refresh_token), baseSeconds + 6);
    setNowSeconds(baseSeconds + 3);
    await shortTtlProvider.exchangeRefreshToken(client, tokens.refresh_token);
    assert.equal(
      readRefreshExpiry(shortTtlDir, tokens.refresh_token),
      baseSeconds + 6,
      "grace must not extend a refresh token past its original earlier expiry",
    );
    setNowSeconds(baseSeconds + 6);
    await shortTtlProvider.exchangeRefreshToken(client, tokens.refresh_token);
    setNowSeconds(baseSeconds + 7);
    await assert.rejects(shortTtlProvider.exchangeRefreshToken(client, tokens.refresh_token), InvalidGrantError);
  } finally {
    shortTtlProvider.close();
    Date.now = realDateNow;
  }
}

async function testGraceDoesNotRelaxRefreshPolicy(): Promise<void> {
  const stateDir = join(root, "policy");
  const config = { ...baseConfig, refreshTokenGraceSeconds: 600 };
  const provider = new SingleUserOAuthProvider(config, serverUrl, stateDir);
  try {
    const { client, tokens } = await issueInitialTokens(provider);
    const otherClient = await provider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
    assert.ok(otherClient);
    await provider.exchangeRefreshToken(client, tokens.refresh_token);

    await assert.rejects(provider.exchangeRefreshToken(otherClient, tokens.refresh_token), InvalidGrantError);
    await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token, ["write"]), AccessDeniedError);
    await assert.rejects(
      provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, otherResource),
      InvalidGrantError,
    );
  } finally {
    provider.close();
  }
}

async function issueInitialTokens(provider: SingleUserOAuthProvider) {
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "Test client",
  });
  assert.ok(client);
  const code = `test-code-${Math.random()}`;
  provider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, resource);
  assert.ok(tokens.refresh_token);
  return { client, tokens: { ...tokens, refresh_token: tokens.refresh_token } };
}

function readRefreshExpiry(stateDir: string, token: string): number | undefined {
  const store = new SqliteOAuthStore(stateDir);
  try {
    return store.getRefreshToken(hashToken(token))?.expiresAt;
  } finally {
    store.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function setNowSeconds(seconds: number): void {
  Date.now = () => seconds * 1000;
}
