import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestDevspaceConfig } from "../src/test-support/config.test.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

testPackedPackageLaunchers();

function testPackedPackageLaunchers(): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-packed-bin-test-"));
  const installRoot = join(root, "install");
  try {
    mkdirSync(installRoot, { recursive: true });
    execFileSync(npmExecutable(), ["pack", "--silent", "--pack-destination", root], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    const archive = readdirSync(root).find((name) => name.endsWith(".tgz"));
    assert.ok(archive, "npm pack must produce a package archive");

    execFileSync(npmExecutable(), [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--omit=optional",
      join(root, archive),
    ], {
      cwd: installRoot,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });

    const configRoot = join(root, "config");
    const env = writeTestDevspaceConfig(configRoot, {
      storage: { stateDir: join(root, "state") },
      workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
      skills: { agentDir: join(root, "agents") },
    });
    const cliOutput = execInstalledBin(installRoot, "devspace", ["config", "get"], {
      ...process.env,
      ...env,
    });
    const config = JSON.parse(cliOutput) as { tools?: { mode?: string } };
    assert.equal(config.tools?.mode, "codex");

    execInstalledBin(installRoot, "devspace-agentd", [], {
      ...process.env,
      ...env,
      DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "0",
      DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS: "1000",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function execInstalledBin(
  installRoot: string,
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  return execFileSync(executable, args, {
    encoding: "utf8",
    env,
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}
