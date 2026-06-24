import assert from "node:assert/strict";
import { checkEndpoint } from "./health.js";

assert.deepEqual(
  await checkEndpoint("http://127.0.0.1:7676/healthz", async () => new Response("ok", { status: 200 })),
  { ok: true, status: 200 },
);

assert.deepEqual(
  await checkEndpoint("https://stale.example.com/healthz", async () => {
    throw new TypeError("fetch failed");
  }),
  { ok: false, error: "fetch failed" },
);

assert.deepEqual(
  await checkEndpoint("https://example.com/healthz", async () => new Response("no", { status: 502 })),
  { ok: false, status: 502, error: "HTTP 502" },
);
