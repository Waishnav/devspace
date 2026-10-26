import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpencodeServer } from "./local-agent-opencode-server.js";
import {
  classifyOpenCodeCliVersion,
  probeOpenCodeBinary,
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

// OPENCODE_COMMAND replaces `opencode` for both the version probe and `opencode serve`.
if (process.platform !== "win32") {
  const directory = mkdtempSync(join(tmpdir(), "devspace-opencode-command-"));
  try {
    const executable = join(directory, "opencode-wrapper");
    writeFileSync(executable, [
      "#!/bin/sh",
      "if [ \"$1\" = --version ]; then echo 2.9.0; exit 0; fi",
      "port=${3#--port=}",
      "echo \"opencode server listening on http://127.0.0.1:$port\"",
      "exec sleep 30",
      "",
    ].join("\n"));
    chmodSync(executable, 0o700);
    const env = { PATH: process.env.PATH, OPENCODE_COMMAND: executable };
    assert.deepEqual(await probeOpenCodeBinary(env), { generation: "v2", version: "2.9.0" });
    const server = await startOpencodeServer(env);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    server.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
