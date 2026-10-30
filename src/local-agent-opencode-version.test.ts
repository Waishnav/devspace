import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOpencodeServer } from "./local-agent-opencode-server.js";
import {
  classifyOpenCodeCliVersion,
  probeOpenCodeBinary,
  encodeOpenCodeV2SessionId,
  requireOpenCodeV1NativeSessionId,
  requireOpenCodeV2NativeSessionId,
  runOpenCodeModels,
} from "./local-agent-opencode-version.js";

test("CLI version output is classified into a protocol generation", () => {
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
});

test("session ids are bound to the protocol generation that created them", () => {
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
});

// OPENCODE_COMMAND replaces `opencode` for both the version probe and `opencode serve`.
test(
  "OPENCODE_COMMAND replaces opencode for the version probe and serve",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "devspace-opencode-command-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  },
);

test("opencode models stops a flooding process and reports only after it exits", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-opencode-models-"));
  const command = join(root, "opencode");
  const pidFile = join(root, "pid");

  try {
    // Ignores SIGTERM and prints past the 4 MiB cap, so only the SIGKILL escalation can end it.
    writeFileSync(command, `#!/bin/sh\necho $$ > "${pidFile}"\ntrap '' TERM\nsleep 30 &\necho $! >> "${pidFile}"\nhead -c 5000000 /dev/zero | tr '\\0' x\nwait\n`);
    chmodSync(command, 0o755);

    await assert.rejects(runOpenCodeModels({ ...process.env, OPENCODE_COMMAND: command }, root), /more than 4 MiB/);

    // The command and a process it started (`sleep`) are both gone once the call rejects.
    for (const pid of readFileSync(pidFile, "utf8").trim().split("\n").map(Number)) {
      assert.throws(() => process.kill(pid, 0), `process ${pid} is gone once the call rejects`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
