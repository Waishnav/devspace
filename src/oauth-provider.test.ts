import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";

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
  assert.deepEqual(savedState.approvedConsents, []);
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
  assert.deepEqual(repairedState, { version: 1, clients: [], accessTokens: [], refreshTokens: [], approvedConsents: [] });

  const emptyStatePath = join(root, "empty", "oauth.json");
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(emptyStatePath, "");
  await chmod(emptyStatePath, 0o600);
  const emptyProvider = new SingleUserOAuthProvider({ ...config, statePath: emptyStatePath }, resourceServerUrl);
  assert.equal(emptyProvider.clientsStore.getClient(client.client_id), undefined);
  const rewrittenEmptyState = JSON.parse(readFileSync(emptyStatePath, "utf8"));
  assert.deepEqual(rewrittenEmptyState, { version: 1, clients: [], accessTokens: [], refreshTokens: [], approvedConsents: [] });

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

  const consentStatePath = join(root, "consent", "oauth.json");
  const consentProvider = new SingleUserOAuthProvider({ ...config, statePath: consentStatePath }, resourceServerUrl);
  const consentClient = consentProvider.clientsStore.registerClient({
    client_name: "consent client",
    redirect_uris: ["http://localhost/consent", "http://localhost/other"],
    scope: "devspace",
  });
  const consentParams = authorizationParams("http://localhost/consent", resourceServerUrl, ["devspace"], "state-1");

  const firstConsentGet = mockResponse("GET");
  await consentProvider.authorize(consentClient, consentParams, firstConsentGet.res);
  assert.equal(firstConsentGet.statusCode, 200);
  assert.match(assertString(firstConsentGet.body), /Owner password/);

  const firstConsentPost = mockResponse("POST", { owner_token: config.ownerToken });
  await consentProvider.authorize(consentClient, consentParams, firstConsentPost.res);
  assert.equal(firstConsentPost.redirectStatus, 302);
  assert.equal(firstConsentPost.redirectUrl?.searchParams.get("state"), "state-1");
  assert.match(assertPresentString(firstConsentPost.redirectUrl?.searchParams.get("code")), /^code-/);

  const consentSavedState = JSON.parse(readFileSync(consentStatePath, "utf8"));
  assert.equal(consentSavedState.approvedConsents.length, 1);
  assert.equal(consentSavedState.approvedConsents[0].clientId, consentClient.client_id);
  assert.equal(consentSavedState.approvedConsents[0].redirectUri, "http://localhost/consent");
  assert.equal(consentSavedState.approvedConsents[0].resource, resourceServerUrl.href);
  assert.deepEqual(consentSavedState.approvedConsents[0].scopes, ["devspace"]);
  assert.equal(JSON.stringify(consentSavedState).includes(config.ownerToken), false);

  const secondConsentGet = mockResponse("GET");
  await consentProvider.authorize(consentClient, consentParams, secondConsentGet.res);
  assert.equal(secondConsentGet.redirectStatus, 302);
  assert.equal(assertUrl(secondConsentGet.redirectUrl).origin + assertUrl(secondConsentGet.redirectUrl).pathname, "http://localhost/consent");
  assert.equal(secondConsentGet.redirectUrl?.searchParams.get("state"), "state-1");
  assert.match(assertPresentString(secondConsentGet.redirectUrl?.searchParams.get("code")), /^code-/);
  assert.notEqual(secondConsentGet.redirectUrl?.searchParams.get("code"), firstConsentPost.redirectUrl?.searchParams.get("code"));
  assert.equal(secondConsentGet.body, undefined);

  const changedRedirectGet = mockResponse("GET");
  await consentProvider.authorize(
    consentClient,
    authorizationParams("http://localhost/other", resourceServerUrl, ["devspace"], "state-redirect"),
    changedRedirectGet.res,
  );
  assert.equal(changedRedirectGet.statusCode, 200);
  assert.match(assertString(changedRedirectGet.body), /Owner password/);

  const changedResourceGet = mockResponse("GET");
  await consentProvider.authorize(
    consentClient,
    authorizationParams("http://localhost/consent", new URL("https://devspace.example.com/mcp/"), ["devspace"], "state-resource"),
    changedResourceGet.res,
  );
  assert.equal(changedResourceGet.statusCode, 200);
  assert.match(assertString(changedResourceGet.body), /Owner password/);

  const expandedScopeStatePath = join(root, "expanded-scope", "oauth.json");
  const expandedScopeProvider = new SingleUserOAuthProvider(
    { ...config, scopes: ["devspace", "admin"], statePath: expandedScopeStatePath },
    resourceServerUrl,
  );
  const expandedScopeClient = expandedScopeProvider.clientsStore.registerClient({
    client_name: "expanded scope client",
    redirect_uris: ["http://localhost/expanded"],
    scope: "devspace admin",
  });
  await expandedScopeProvider.authorize(
    expandedScopeClient,
    authorizationParams("http://localhost/expanded", resourceServerUrl, ["devspace"], "state-scope-1"),
    mockResponse("POST", { owner_token: config.ownerToken }).res,
  );
  const expandedScopeGet = mockResponse("GET");
  await expandedScopeProvider.authorize(
    expandedScopeClient,
    authorizationParams("http://localhost/expanded", resourceServerUrl, ["devspace", "admin"], "state-scope-2"),
    expandedScopeGet.res,
  );
  assert.equal(expandedScopeGet.statusCode, 200);
  assert.match(assertString(expandedScopeGet.body), /Owner password/);

  const restartedConsentProvider = new SingleUserOAuthProvider({ ...config, statePath: consentStatePath }, resourceServerUrl);
  const restartedConsentClient = restartedConsentProvider.clientsStore.getClient(consentClient.client_id);
  assert.equal(Boolean(restartedConsentClient), true);
  const restartedConsentGet = mockResponse("GET");
  await restartedConsentProvider.authorize(assertClient(restartedConsentClient), consentParams, restartedConsentGet.res);
  assert.equal(restartedConsentGet.redirectStatus, 302);
  assert.equal(assertUrl(restartedConsentGet.redirectUrl).origin + assertUrl(restartedConsentGet.redirectUrl).pathname, "http://localhost/consent");

  const finalConsentState = JSON.parse(readFileSync(consentStatePath, "utf8"));
  assert.equal(JSON.stringify(finalConsentState).includes(config.ownerToken), false);
  assert.equal(JSON.stringify(finalConsentState).includes(assertString(firstTokens.access_token)), false);
  assert.equal(JSON.stringify(finalConsentState).includes(assertString(firstTokens.refresh_token)), false);
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

function assertPresentString(value: string | null | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}

function hashTestToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function authorizationParams(
  redirectUri: string,
  resource: URL,
  scopes: string[],
  state: string,
): AuthorizationParams {
  return {
    redirectUri,
    codeChallenge: "challenge",
    scopes,
    state,
    resource,
  };
}

function mockResponse(method: "GET" | "POST", body: Record<string, string> = {}) {
  const result: {
    statusCode?: number;
    headers: Record<string, string>;
    body?: string;
    redirectStatus?: number;
    redirectUrl?: URL;
    res: any;
  } = {
    headers: {},
    res: undefined,
  };
  result.res = {
    req: { method, body },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      result.headers[name] = value;
      return this;
    },
    send(bodyValue: string) {
      result.body = bodyValue;
      return this;
    },
    redirect(code: number, url: string) {
      result.redirectStatus = code;
      result.redirectUrl = new URL(url);
      return this;
    },
  };
  return result;
}

function assertClient(client: OAuthClientInformationFull | undefined): OAuthClientInformationFull {
  if (!client) {
    throw new Error("Expected OAuth client");
  }
  return client;
}

function assertUrl(url: URL | undefined): URL {
  if (!url) {
    throw new Error("Expected URL");
  }
  return url;
}
