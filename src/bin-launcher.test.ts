import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxRoot = join(projectRoot, "node_modules", "tsx");

for (const entrypoint of [
  {
    bin: "devspace.js",
    source: "src/cli.ts",
    dist: "dist/cli.js",
  },
  {
    bin: "devspace-agentd.js",
    source: "src/local-agent-daemon-main.ts",
    dist: "dist/local-agent-daemon-main.js",
  },
]) {
  testLauncher(entrypoint);
}

testLinkedCheckoutReadsCurrentConfig();
testMissingSourceRuntimeFailsClosed();
testPackedPackageLaunchers();

function testLinkedCheckoutReadsCurrentConfig(): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-bin-config-test-"));
  try {
    const env = writeTestDevspaceConfig(root, { tools: { mode: "codex" } });
    const output = execFileSync(process.execPath, [join(projectRoot, "bin", "devspace.js"), "config", "get"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(output) as { tools?: { mode?: string } };
    assert.equal(config.tools?.mode, "codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testMissingSourceRuntimeFailsClosed(): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-bin-missing-tsx-test-"));
  try {
    cpSync(join(projectRoot, "bin"), join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "src", "cli.ts"), 'console.log("source");\n');
    writeFileSync(join(root, "dist", "cli.js"), 'console.log("stale-dist");\n');

    assert.throws(
      () => execFileSync(process.execPath, [join(root, "bin", "devspace.js")], { encoding: "utf8", stdio: "pipe" }),
      /source checkout.*tsx.*pnpm install/is,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

function testLauncher(entrypoint: { bin: string; source: string; dist: string }): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-bin-launcher-test-"));
  try {
    cpSync(join(projectRoot, "bin"), join(root, "bin"), { recursive: true });
    mkdirSync(dirname(join(root, entrypoint.source)), { recursive: true });
    mkdirSync(dirname(join(root, entrypoint.dist)), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(tsxRoot, join(root, "node_modules", "tsx"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, entrypoint.source), 'console.log("source");\n');
    writeFileSync(join(root, entrypoint.dist), 'console.log("dist");\n');

    const sourceOutput = execFileSync(process.execPath, [join(root, "bin", entrypoint.bin)], {
      encoding: "utf8",
    }).trim();
    assert.equal(sourceOutput, "source", `${entrypoint.bin} must prefer source in a linked checkout`);

    rmSync(join(root, entrypoint.source));
    const packagedOutput = execFileSync(process.execPath, [join(root, "bin", entrypoint.bin)], {
      encoding: "utf8",
    }).trim();
    assert.equal(packagedOutput, "dist", `${entrypoint.bin} must use dist in a published package`);
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
