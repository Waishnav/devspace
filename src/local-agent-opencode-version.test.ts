import assert from "node:assert/strict";
import {
  classifyOpenCodeCliVersion,
  encodeOpenCodeV2SessionId,
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
