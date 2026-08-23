import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createPiSandboxConfig,
  createPiSandboxExtension,
  createPiSandboxModeRef,
  registerPiSandboxSession,
  releasePiSandboxSession,
} from "./local-agent-pi-sandbox.js";

const dependencies = await SandboxManager.checkDependenciesAsync();
if (process.env.DEVSPACE_REQUIRE_PI_SANDBOX === "1") {
  assert.equal(SandboxManager.isSupportedPlatform(), true, "Pi sandbox integration is required on this CI lane");
  assert.deepEqual(dependencies.errors, [], "Pi sandbox dependencies must be available on this CI lane");
}
if (SandboxManager.isSupportedPlatform() && dependencies.errors.length === 0) {
  const root = await mkdtemp(join(tmpdir(), "devspace-pi-sandbox-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const outside = join(root, "outside.txt");
  const session = {};
  const modeRef = createPiSandboxModeRef("allowed");
  const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();

  try {
    createPiSandboxExtension(workspace, modeRef)({
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
    } as never);
    await registerPiSandboxSession(session, workspace, modeRef, "allowed");

    const bash = tools.get("bash");
    assert.ok(bash, "Pi sandbox extension registers a bash tool");
    await bash.execute("bash-inside-write-test", {
      command: `touch '${join(workspace, "inside.txt")}'`,
    });
    assert.equal(
      existsSync(join(workspace, "inside.txt")),
      true,
      "sandboxed Pi bash can write inside the workspace",
    );
    await assert.rejects(
      bash.execute("bash-outside-write-test", {
        command: `touch '${outside}'`,
      }),
      /Read-only file system|Command exited with code/,
    );
    assert.equal(existsSync(outside), false, "sandboxed Pi bash cannot write outside the workspace");

    const read = tools.get("read");
    assert.ok(read, "Pi sandbox extension registers a read tool");
    await assert.rejects(
      read.execute("read-test", { path: outside }),
      /outside the allowed root|outside allowed roots|outside the workspace|not allowed/i,
    );

    const outsideDirectory = join(root, "outside-directory");
    mkdirSync(outsideDirectory);
    await writeFile(join(outsideDirectory, "secret.txt"), "secret");
    const symlinkPath = join(workspace, "outside-link");
    await symlink(outsideDirectory, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      read.execute("symlink-read-test", { path: join(symlinkPath, "secret.txt") }),
      /outside the allowed root|outside allowed roots|outside the workspace|not allowed/i,
      "restricted Pi reads must resolve symlinks before enforcing the workspace boundary",
    );

    const write = tools.get("write");
    assert.ok(write, "Pi sandbox extension registers a write tool");
    modeRef.value = "read_only";
    assert.throws(
      () => write.execute("read-only-write-test", { path: join(workspace, "blocked.txt"), content: "blocked" }),
      /read-only mode/,
      "read-only mode rejects write-capable tools even if a provider attempts to invoke one",
    );
    modeRef.value = "allowed";

    const envPath = join(workspace, ".env");
    const resolvedEnvPath = join(realpathSync(workspace), ".env");
    assert.ok(
      createPiSandboxConfig(workspace).filesystem.denyWrite.includes(resolvedEnvPath),
      "the process-global sandbox config protects workspace environment files on Windows too",
    );
    await writeFile(envPath, "before\n");
    await assert.rejects(
      bash.execute("env-write-test", { command: `printf 'after\\n' > '${envPath}'` }),
      /Read-only file system|Command exited with code/,
      "sandboxed Pi bash cannot overwrite protected workspace environment files",
    );
  } finally {
    await releasePiSandboxSession(session);
    await rm(root, { recursive: true, force: true });
  }
} else {
  console.log("Pi sandbox integration test skipped: sandbox-runtime dependencies are unavailable.");
}
