import assert from "node:assert/strict";
import {
  classifyOpenCodeCliVersion,
  encodeOpenCodeV2SessionId,
  OpenCodeRuntimeProbe,
  requireOpenCodeV1NativeSessionId,
  requireOpenCodeV2NativeSessionId,
} from "./local-agent-opencode-version.js";

assert.deepEqual(classifyOpenCodeCliVersion("1.18.32\n"), {
  generation: "v1",
  version: "1.18.32",
});
assert.deepEqual(classifyOpenCodeCliVersion("opencode v2.0.20\n"), {
  generation: "v2",
  version: "2.0.20",
});
assert.deepEqual(classifyOpenCodeCliVersion("opencode v2.1.0-beta.2\n"), {
  generation: "v2",
  version: "2.1.0-beta.2",
});
assert.equal(classifyOpenCodeCliVersion("opencode unknown"), undefined);

assert.equal(encodeOpenCodeV2SessionId("ses_v2"), "opencode:v2:ses_v2");
assert.equal(requireOpenCodeV2NativeSessionId("opencode:v2:ses_v2"), "ses_v2");
assert.equal(requireOpenCodeV1NativeSessionId("ses_v1"), "ses_v1");
assert.throws(
  () => requireOpenCodeV2NativeSessionId("ses_v1"),
  /different OpenCode protocol generation/,
);
assert.throws(
  () => requireOpenCodeV1NativeSessionId("opencode:v2:ses_v2"),
  /different OpenCode protocol generation/,
);

let successfulCalls = 0;
const cached = new OpenCodeRuntimeProbe(async () => {
  successfulCalls += 1;
  return { generation: "v2", version: "2.0.20" };
});
assert.deepEqual(await cached.get(), { generation: "v2", version: "2.0.20" });
assert.deepEqual(await cached.get(), { generation: "v2", version: "2.0.20" });
assert.equal(successfulCalls, 1, "successful probes are cached");

let attempts = 0;
const retriesFailures = new OpenCodeRuntimeProbe(async () => {
  attempts += 1;
  if (attempts === 1) throw new Error("not ready");
  return { generation: "v1", version: "1.18.32" };
});
await assert.rejects(() => retriesFailures.get(), /not ready/);
assert.deepEqual(await retriesFailures.get(), { generation: "v1", version: "1.18.32" });
assert.equal(attempts, 2, "failed probes are not cached");
