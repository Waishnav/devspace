import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { requestIp, type TrustProxyMode } from "./logger.js";

async function observedIps(trustProxy: TrustProxyMode): Promise<{ reqIp: string; logged: string }> {
  const app = express();
  if (trustProxy) app.set("trust proxy", trustProxy);
  app.get("/", (req, res) => {
    res.json({ reqIp: req.ip, logged: requestIp(req, trustProxy) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    // The client supplies the leftmost hop; the local proxy appends the real peer.
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.7" },
    });
    return await response.json() as { reqIp: string; logged: string };
  } finally {
    server.close();
  }
}

test("disabled trust proxy ignores forwarding headers", async () => {
  assert.deepEqual(await observedIps(false), { reqIp: "127.0.0.1", logged: "127.0.0.1" });
});

test("loopback trust proxy uses the hop appended by the local proxy", async () => {
  assert.deepEqual(await observedIps("loopback"), { reqIp: "203.0.113.7", logged: "203.0.113.7" });
});

test("full trust proxy accepts the client-supplied hop", async () => {
  assert.deepEqual(await observedIps(true), { reqIp: "198.51.100.66", logged: "198.51.100.66" });
});
