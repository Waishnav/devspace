import assert from "node:assert/strict";
import {
  buildCloudflareTunnelCommand,
  extractTryCloudflareUrl,
  resolveTunnelMode,
} from "./cloudflare-tunnel.js";

assert.equal(resolveTunnelMode(), undefined);
assert.equal(resolveTunnelMode({ args: ["--tunnel"] }), "cloudflare");
assert.equal(resolveTunnelMode({ args: ["--tunnel=cloudflare"] }), "cloudflare");
assert.equal(resolveTunnelMode({ args: ["--tunnel", "--no-tunnel"] }), undefined);
assert.equal(resolveTunnelMode({ env: { DEVSPACE_TUNNEL: "cloudflare" } as NodeJS.ProcessEnv }), "cloudflare");
assert.equal(resolveTunnelMode({ env: { DEVSPACE_TUNNEL: "off" } as NodeJS.ProcessEnv }), undefined);
assert.equal(resolveTunnelMode({ configuredTunnel: "cloudflare" }), "cloudflare");
assert.equal(
  resolveTunnelMode({
    args: ["--no-tunnel"],
    env: { DEVSPACE_TUNNEL: "cloudflare" } as NodeJS.ProcessEnv,
    configuredTunnel: "cloudflare",
  }),
  undefined,
);

assert.equal(
  extractTryCloudflareUrl("INF Requesting new quick Tunnel on trycloudflare.com...\nhttps://abc-123.trycloudflare.com"),
  "https://abc-123.trycloudflare.com",
);
assert.equal(
  extractTryCloudflareUrl("https://abc.trycloudflare.com and then https://def.trycloudflare.com"),
  "https://abc.trycloudflare.com",
);
assert.equal(extractTryCloudflareUrl("https://example.com"), undefined);
assert.equal(extractTryCloudflareUrl("https://nottrycloudflare.example.com"), undefined);

assert.deepEqual(
  buildCloudflareTunnelCommand("cloudflared", "http://127.0.0.1:7676"),
  {
    command: "cloudflared",
    args: ["tunnel", "--url", "http://127.0.0.1:7676", "--no-autoupdate"],
  },
);
