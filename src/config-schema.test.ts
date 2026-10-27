import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  devspaceConfigJsonSchema,
  devspaceConfigSchema,
} from "./config-schema.js";

test("the config schema rejects unrecognized keys", () => {
  assert.throws(
    () => devspaceConfigSchema.parse({ configVersion: 1, typo: true }),
    /Unrecognized key/,
  );
});

test("oauth.refreshTokenGraceSeconds defaults to 0 and accepts integers from 0 to 600", () => {
  assert.equal(devspaceConfigSchema.parse({ configVersion: 1 }).oauth.refreshTokenGraceSeconds, 0);
  for (const refreshTokenGraceSeconds of [0, 1, 600]) {
    assert.equal(devspaceConfigSchema.parse({
      configVersion: 1, oauth: { refreshTokenGraceSeconds },
    }).oauth.refreshTokenGraceSeconds, refreshTokenGraceSeconds);
  }
  for (const refreshTokenGraceSeconds of [-1, 601, 1.5, "600"]) {
    assert.equal(devspaceConfigSchema.safeParse({
      configVersion: 1, oauth: { refreshTokenGraceSeconds },
    }).success, false);
  }
});

test("oauth.allowedResourceUrls accepts HTTPS and loopback HTTP URLs only", () => {
  for (const url of [
    "https://tunnel.example.com/v1/mcp/tunnel_123",
    "http://localhost:7676/mcp",
    "http://127.0.0.1:7676/mcp",
    "http://[::1]:7676/mcp",
  ]) {
    assert.doesNotThrow(() => devspaceConfigSchema.parse({
      configVersion: 1, oauth: { allowedResourceUrls: [url] },
    }), url);
  }
  for (const url of [
    "http://tunnel.example.com/mcp", "http://192.168.1.1/mcp",
    "http://localhost.example.com/mcp", "http://127.0.0.1.example.com/mcp",
    "http://[::2]/mcp", "ftp://localhost/mcp", "file:///mcp",
    "custom://tunnel.example.com/mcp", "not-a-url",
  ]) {
    assert.equal(devspaceConfigSchema.safeParse({
      configVersion: 1, oauth: { allowedResourceUrls: [url] },
    }).success, false, url);
  }
});

test("the committed JSON schema matches the generated config schema", () => {
  const generatedSchema = `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`;
  const committedSchema = readFileSync(
    new URL("../schema/v1/devspace.schema.json", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");
});
