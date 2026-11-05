import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeTestDevspaceConfig } from "../src/test-support/config.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("the packed package installs working devspace and devspace-agentd launchers", () => {
  testPackedPackageLaunchers();
});

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

    // SAFETY: The surrounding checks or construction already match this type.
    const config = JSON.parse(cliOutput) as { configVersion?: number };
    assert.equal(config.configVersion, 1);

    execInstalledBin(installRoot, "devspace-agentd", [], {
      ...process.env,
      ...env,
      DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "0",
      DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS: "1000",
    });

    // A fresh machine has no config, auth, or OAuth setup; agent commands must still work.
    const home = join(root, "home");

    const freshEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DEVSPACE_CONFIG_DIR: join(root, "fresh-config"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "",
    };

    // SAFETY: The surrounding checks or construction already match this type.
    const targets = JSON.parse(
      execInstalledBin(installRoot, "devspace", ["agents", "targets", "--json"], freshEnv),
    ) as { enabled: boolean; targets: Array<{ name: string }> };

    assert.equal(targets.enabled, true);
    assert.ok(targets.targets.some((target) => target.name === "claude"));
    assert.match(
      execInstalledBin(installRoot, "devspace", ["agents", "skill"], freshEnv),
      /^---\nname: devspace-agents\n/,
    );
    execInstalledBin(installRoot, "devspace", ["agents", "skill", "--install", "claude-code"], freshEnv);
    assert.ok(existsSync(join(home, ".claude", "skills", "devspace-agents", "SKILL.md")));
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
