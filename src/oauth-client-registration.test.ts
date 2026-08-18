import assert from "node:assert/strict";
import {
  createRecoverableClientId,
  recoverClientRegistration,
} from "./oauth-client-registration.js";

const signingKey = "test-client-registration-key-that-is-long-enough";
const client = {
  redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
  client_name: "ChatGPT",
  client_id_issued_at: 1_786_032_000,
  token_endpoint_auth_method: "none" as const,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

const created = createRecoverableClientId(client, signingKey);
assert.equal(created.kind, "recoverable");
if (created.kind !== "recoverable") throw new Error("Expected recoverable client ID");
const clientId = created.clientId;
assert.match(clientId, /^devspace-v1\./);

const recovered = recoverClientRegistration(clientId, signingKey);
assert.ok(recovered);
assert.equal(recovered.client_id, clientId);
assert.equal(recovered.client_name, "ChatGPT");
assert.deepEqual(recovered.redirect_uris, client.redirect_uris);
assert.deepEqual(recovered.grant_types, client.grant_types);

const parts = clientId.split(".");
assert.equal(parts.length, 3);
assert.equal(
  recoverClientRegistration(`${parts[0]}.${parts[1]}x.${parts[2]}`, signingKey),
  undefined,
);
assert.equal(
  recoverClientRegistration(`${parts[0]}.${parts[1]}.${parts[2]}x`, signingKey),
  undefined,
);
assert.equal(recoverClientRegistration(clientId, `${signingKey}-wrong`), undefined);
assert.equal(recoverClientRegistration(`devspace-v1.${"x".repeat(5000)}.signature`, signingKey), undefined);
assert.equal(
  recoverClientRegistration("devspace-0b3f9c1e-2d4a-4f77-9c0e-1a2b3c4d5e6f", signingKey),
  undefined,
);
assert.equal(recoverClientRegistration(`${clientId}.extra`, signingKey), undefined);

assert.deepEqual(
  createRecoverableClientId(
    {
      ...client,
      token_endpoint_auth_method: "client_secret_post",
      client_secret: "must-not-be-embedded",
    },
    signingKey,
  ),
  { kind: "unsupported" },
);

const oversized = createRecoverableClientId(
  { ...client, client_name: "x".repeat(5000) },
  signingKey,
);
assert.equal(oversized.kind, "too_large");
