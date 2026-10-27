import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createUserNamespaceDenialDetector,
  isUserNamespaceDenied,
  createPiSandboxConfig,
  createPiSandboxExtension,
  createPiSandboxModeRef,
  registerPiSandboxSession,
  releasePiSandboxSession,
  type PiSandboxModeRef,
} from "./local-agent-pi-sandbox.js";

type PiTool = { execute: (...args: any[]) => Promise<unknown> };

function registerTools(workspace: string, modeRef: PiSandboxModeRef, env?: NodeJS.ProcessEnv): Map<string, PiTool> {
  const tools = new Map<string, PiTool>();
  createPiSandboxExtension(workspace, modeRef, env)({
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
  } as never);

  return tools;
}

const dependencies = await SandboxManager.checkDependenciesAsync();
const sandboxRequired = process.env.DEVSPACE_REQUIRE_PI_SANDBOX === "1";
const sandboxAvailable = SandboxManager.isSupportedPlatform() && dependencies.errors.length === 0;

// When this lane requires the sandbox the integration tests run and fail on missing dependencies instead of skipping.
const sandboxSkip = sandboxAvailable || sandboxRequired
  ? false
  : "Pi sandbox integration test skipped: sandbox-runtime dependencies are unavailable.";

async function sandboxFixture(t: TestContext) {
  if (sandboxRequired) {
    assert.equal(SandboxManager.isSupportedPlatform(), true, "Pi sandbox integration is required on this CI lane");
    assert.deepEqual(dependencies.errors, [], "Pi sandbox dependencies must be available on this CI lane");
  }

  const root = await mkdtemp(join(tmpdir(), "devspace-pi-sandbox-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const outside = join(root, "outside.txt");
  const session = {};
  const modeRef = createPiSandboxModeRef("allowed");
  t.after(async () => {
    await releasePiSandboxSession(session);
    await rm(root, { recursive: true, force: true });
  });
  const tools = registerTools(workspace, modeRef);
  await registerPiSandboxSession(session, workspace, modeRef, "allowed");

  return { root, workspace, outside, modeRef, tools };
}

async function outsideDirectoryFixture(root: string): Promise<string> {
  const outsideDirectory = join(root, "outside-directory");
  mkdirSync(outsideDirectory);
  await writeFile(join(outsideDirectory, "secret.txt"), "secret");

  return outsideDirectory;
}

test("full-access bash receives the provider env", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "devspace-pi-env-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const modeRef = createPiSandboxModeRef("full_access");

  const tools = registerTools(workspace, modeRef, {
    ...process.env,
    DEVSPACE_PI_ENV_TEST: "provider-env",
  });

  const bash = tools.get("bash");
  assert.ok(bash);

  const result = await bash.execute("provider-env-test", { command: "printf %s \"$DEVSPACE_PI_ENV_TEST\"" }) as {
    content: Array<{ type: string; text?: string }>;
  };

  assert.equal(result.content[0]?.text, "provider-env");
});

test("user namespace denials are detected, including across chunks", () => {
  assert.equal(
    isUserNamespaceDenied("apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied"),
    true,
  );
  assert.equal(isUserNamespaceDenied("bwrap: setting up uid map: Permission denied"), true);

  const splitDenial = createUserNamespaceDenialDetector();
  splitDenial.push("apply-seccomp: write /proc/self/setgroups (nested userns is capab");
  splitDenial.push("ility-restricted; caller must provide CAP_SYS_ADMIN)");
  assert.equal(splitDenial.denied, true, "a denial split across chunks is detected");
  assert.equal(isUserNamespaceDenied("touch: cannot touch 'x': Permission denied"), false);
});

test("sandboxed bash writes inside the workspace but not outside", { skip: sandboxSkip }, async (t) => {
  const { workspace, outside, tools } = await sandboxFixture(t);
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
});

test("restricted reads reject paths outside the workspace", { skip: sandboxSkip }, async (t) => {
  const { outside, tools } = await sandboxFixture(t);
  const read = tools.get("read");
  assert.ok(read, "Pi sandbox extension registers a read tool");
  await assert.rejects(
    read.execute("read-test", { path: outside }),
    /outside the allowed root|outside allowed roots|outside the workspace|not allowed/i,
  );
});

test("restricted reads resolve symlinks before enforcing the workspace boundary", { skip: sandboxSkip }, async (t) => {
  const { root, workspace, tools } = await sandboxFixture(t);
  const read = tools.get("read");
  assert.ok(read, "Pi sandbox extension registers a read tool");
  const outsideDirectory = await outsideDirectoryFixture(root);
  const symlinkPath = join(workspace, "outside-link");
  await symlink(outsideDirectory, symlinkPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    read.execute("symlink-read-test", { path: join(symlinkPath, "secret.txt") }),
    /outside the allowed root|outside allowed roots|outside the workspace|not allowed/i,
    "restricted Pi reads must resolve symlinks before enforcing the workspace boundary",
  );
});

test("read-only mode rejects write-capable tools", { skip: sandboxSkip }, async (t) => {
  const { workspace, modeRef, tools } = await sandboxFixture(t);
  const write = tools.get("write");
  assert.ok(write, "Pi sandbox extension registers a write tool");
  modeRef.value = "read_only";
  assert.throws(
    () => write.execute("read-only-write-test", { path: join(workspace, "blocked.txt"), content: "blocked" }),
    /read-only mode/,
    "read-only mode rejects write-capable tools even if a provider attempts to invoke one",
  );
  modeRef.value = "allowed";
});

test("workspace environment files are protected from sandboxed bash", { skip: sandboxSkip }, async (t) => {
  const { workspace, tools } = await sandboxFixture(t);
  const bash = tools.get("bash");
  assert.ok(bash, "Pi sandbox extension registers a bash tool");
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
});

test("a workspace symlink retargeted outside cannot redirect sandboxed bash", { skip: sandboxSkip }, async (t) => {
  const { root, workspace } = await sandboxFixture(t);
  const outsideDirectory = await outsideDirectoryFixture(root);
  const workspaceAlias = join(root, "workspace-alias");
  await symlink(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
  const retargetedSession = {};
  const retargetedModeRef = createPiSandboxModeRef("allowed");
  const retargetedTools = registerTools(workspaceAlias, retargetedModeRef);
  await registerPiSandboxSession(retargetedSession, workspaceAlias, retargetedModeRef, "allowed");
  await rm(workspaceAlias, { recursive: true, force: true });
  await symlink(outsideDirectory, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
  const escapedBashFile = join(outsideDirectory, "bash-escaped.txt");

  try {
    const retargetedBash = retargetedTools.get("bash");
    assert.ok(retargetedBash);
    await assert.rejects(
      retargetedBash.execute("retargeted-workspace-bash-test", { command: `touch '${escapedBashFile}'` }),
      /outside allowed roots|outside the allowed root|outside the workspace|not allowed/i,
    );
    assert.equal(existsSync(escapedBashFile), false);
  } finally {
    await releasePiSandboxSession(retargetedSession);
  }
});
