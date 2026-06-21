import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServiceManager, detectServiceManagerKind } from "./service/manager.js";
import { buildLaunchAgentPlist, buildSystemdUnit, devspaceLogDir } from "./service/templates.js";
import type { CommandRunner } from "./service/runner.js";

const root = mkdtempSync(join(tmpdir(), "devspace-service-test-"));

try {
  process.env.DEVSPACE_CONFIG_DIR = root;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: root,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });

  const systemdUnit = buildSystemdUnit({
    cliEntrypoint: "/tmp/devspace/dist/cli.js",
    config,
  });
  assert.match(systemdUnit, /ExecStart=/);
  assert.match(systemdUnit, /Restart=on-failure/);
  assert.match(systemdUnit, /devspace\.out\.log/);
  assert.equal(devspaceLogDir(), join(root, "logs"));
  assert.match(systemdUnit, new RegExp(`${escapeRegExp(join(root, "logs", "devspace.out.log"))}`));

  const launchdPlist = buildLaunchAgentPlist({
    cliEntrypoint: "/tmp/devspace/dist/cli.js",
    config,
  });
  assert.match(launchdPlist, /ProgramArguments/);
  assert.match(launchdPlist, /service-run/);
  assert.match(launchdPlist, /devspace\.err\.log/);
  assert.match(launchdPlist, new RegExp(`${escapeRegExp(join(root, "logs", "devspace.err.log"))}`));

  const runner = createMockRunner();
  const manager = createServiceManager({
    config,
    cliEntrypoint: "/tmp/devspace/dist/cli.js",
    runner,
  });
  const status = await manager.status();
  assert.equal(typeof status.installed, "boolean");
  assert.equal(status.endpoint?.endsWith(config.mcpPath), true);

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
    }),
    "unsupported",
  );
  assert.equal(
    detectServiceManagerKind({
      platform: "linux",
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" },
    }),
    "systemd-user",
  );
} finally {
  delete process.env.DEVSPACE_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMockRunner(): CommandRunner {
  return {
    async exec(command, args) {
      if (command === "systemctl" && args.includes("is-enabled")) {
        return { stdout: "enabled", stderr: "", exitCode: 0 };
      }
      if (command === "systemctl" && args.includes("is-active")) {
        return { stdout: "active", stderr: "", exitCode: 0 };
      }
      if (command === "systemctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "launchctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "schtasks.exe") {
        return { stdout: "Status: Running\nScheduled Task State: Enabled\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}
