import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServiceManager, detectServiceManagerKind } from "./service/manager.js";
import { buildLaunchAgentPlist, buildServiceEnvironment, buildSystemdUnit, devspaceLogDir } from "./service/templates.js";
import type { CommandRunner } from "./service/runner.js";
import { writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

const root = mkdtempSync(join(tmpdir(), "devspace-service-test-"));
const originalHome = process.env.HOME;
const originalConfigDir = process.env.DEVSPACE_CONFIG_DIR;
const originalAllowedRoots = process.env.DEVSPACE_ALLOWED_ROOTS;
const originalSessionWorkspace = process.env.DEVSPACE_SESSION_WORKSPACE;
const originalPath = process.env.PATH;

try {
  process.env.HOME = root;
  process.env.DEVSPACE_CONFIG_DIR = root;
  process.env.PATH = "/usr/bin:/bin";
  process.env.DEVSPACE_ALLOWED_ROOTS = "/tmp/should-not-persist";
  process.env.DEVSPACE_SESSION_WORKSPACE = "/tmp/session-only";
  writeDevspaceConfig({
    allowedRoots: [root],
    workspaces: {
      allowed: [root],
      default: null,
    },
    publicBaseUrl: "https://devspace.example.com",
    server: {
      publicBaseUrl: "https://devspace.example.com",
      mcpPath: "/mcp",
      host: "127.0.0.1",
      port: 7676,
    },
  });
  writeDevspaceAuth({ ownerToken: "test-owner-token-that-is-long-enough" });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const serviceEnvironment = buildServiceEnvironment();
  assert.equal(serviceEnvironment.DEVSPACE_ALLOWED_ROOTS, undefined);
  assert.equal(serviceEnvironment.DEVSPACE_SESSION_WORKSPACE, undefined);
  assert.equal(serviceEnvironment.DEVSPACE_CONFIG_DIR, root);
  assert.equal(serviceEnvironment.PATH, "/usr/bin:/bin");

  const builtCliPath = join(root, "dist", "cli.js");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(builtCliPath, "console.log('devspace');\n", "utf8");
  const systemdUnit = buildSystemdUnit({
    cliEntrypoint: builtCliPath,
    config,
  });
  assert.match(systemdUnit, /ExecStart=/);
  assert.match(systemdUnit, /Restart=on-failure/);
  assert.match(systemdUnit, /devspace\.out\.log/);
  assert.equal(devspaceLogDir(), join(root, "logs"));
  assert.match(systemdUnit, new RegExp(`${escapeRegExp(join(root, "logs", "devspace.out.log"))}`));
  assert.doesNotMatch(systemdUnit, /DEVSPACE_ALLOWED_ROOTS/);
  assert.doesNotMatch(systemdUnit, /DEVSPACE_SESSION_WORKSPACE/);

  const launchdPlist = buildLaunchAgentPlist({
    cliEntrypoint: builtCliPath,
    config,
  });
  assert.match(launchdPlist, /ProgramArguments/);
  assert.match(launchdPlist, /service-run/);
  assert.match(launchdPlist, /devspace\.err\.log/);
  assert.match(launchdPlist, new RegExp(`${escapeRegExp(join(root, "logs", "devspace.err.log"))}`));
  assert.doesNotMatch(launchdPlist, /DEVSPACE_ALLOWED_ROOTS/);
  assert.doesNotMatch(launchdPlist, /DEVSPACE_SESSION_WORKSPACE/);

  const runner = createMockRunner();
  const systemdPaths = createSystemdPaths(root, "systemd");
  const manager = createServiceManager({
    config,
    cliEntrypoint: join(root, "src", "cli.ts"),
    runner,
    managerKindOverride: "systemd-user",
    pathsOverride: systemdPaths,
  });
  const startResult = await manager.start();
  assert.equal(startResult.ok, true);
  assert.match(startResult.message, /Started service|Installed and started service/);
  assert.match(readFileSync(systemdPaths.userSystemdUnitPath, "utf8"), new RegExp(escapeRegExp(builtCliPath)));
  const status = await manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.endpoint, "https://devspace.example.com/mcp");
  const doctor = await manager.doctor();
  assert.equal(doctor.checks.some((check) => check.level === "warn" && /running from source/.test(check.message)), true);

  const brokenManager = createServiceManager({
    config,
    cliEntrypoint: join(root, "missing-project", "src", "cli.ts"),
    runner: createMockRunner(),
    managerKindOverride: "systemd-user",
    pathsOverride: createSystemdPaths(root, "broken"),
  });
  const brokenStart = await brokenManager.start();
  assert.equal(brokenStart.ok, false);
  assert.match(brokenStart.message, /Expected built service entrypoint/);

  const logPath = join(root, "logs", "devspace.out.log");
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(logPath, "line-1\nline-2\nline-3\n", "utf8");
  assert.equal(await manager.logs(), "line-1\nline-2\nline-3\n");
  assert.equal(await manager.logs({ tail: 2 }), "line-3\n");

  assert.equal(
    detectServiceManagerKind({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/0" },
    }),
    "systemd-user",
  );
  assert.equal(
    detectServiceManagerKind({
      platform: "linux",
      env: {},
      hasSystemdRuntimeMarkers: false,
    }),
    "unsupported",
  );
  assert.equal(
    detectServiceManagerKind({
      platform: "linux",
      env: {},
      hasSystemdRuntimeMarkers: true,
    }),
    "systemd-user",
  );
  assert.equal(
    detectServiceManagerKind({
      platform: "linux",
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" },
    }),
    "systemd-user",
  );
} finally {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalConfigDir === undefined) delete process.env.DEVSPACE_CONFIG_DIR;
  else process.env.DEVSPACE_CONFIG_DIR = originalConfigDir;
  if (originalAllowedRoots === undefined) delete process.env.DEVSPACE_ALLOWED_ROOTS;
  else process.env.DEVSPACE_ALLOWED_ROOTS = originalAllowedRoots;
  if (originalSessionWorkspace === undefined) delete process.env.DEVSPACE_SESSION_WORKSPACE;
  else process.env.DEVSPACE_SESSION_WORKSPACE = originalSessionWorkspace;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSystemdPaths(baseRoot: string, label: string) {
  return {
    userSystemdUnitPath: join(baseRoot, label, ".config", "systemd", "user", "devspace.service"),
    launchdPlistPath: join(baseRoot, label, "Library", "LaunchAgents", "com.devspace.server.plist"),
  };
}

function createMockRunner(): CommandRunner {
  return {
    async exec(command, args) {
      if (command === "systemctl" && args[0] === "--user" && args.includes("show")) {
        return { stdout: "PATH=/usr/bin\n123\n", stderr: "", exitCode: 0 };
      }
      if (command === "systemctl" && args.includes("is-enabled")) {
        return { stdout: "enabled\n", stderr: "", exitCode: 0 };
      }
      if (command === "systemctl" && args.includes("is-active")) {
        return { stdout: "active\n", stderr: "", exitCode: 0 };
      }
      if (command === "systemctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "launchctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "schtasks.exe") {
        if (args.includes("/FO")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}
