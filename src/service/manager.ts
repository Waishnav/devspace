import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { defaultCommandRunner, type CommandRunner } from "./runner.js";
import { buildLaunchAgentPlist, buildServiceCommand, buildSystemdUnit, devspaceLogDir } from "./templates.js";
import type {
  ServiceDoctorResult,
  ServiceManager,
  ServiceManagerKind,
  ServiceResult,
  ServiceStatus,
} from "./types.js";

const SYSTEMD_SERVICE_NAME = "devspace.service";
const LAUNCHD_LABEL = "com.devspace.server";
const WINDOWS_TASK_NAME = "DevSpace MCP Server";

interface ManagerContext {
  config: ServerConfig;
  cliEntrypoint: string;
  runner?: CommandRunner;
}

interface DetectServiceManagerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function createServiceManager(context: ManagerContext): ServiceManager {
  const kind = detectServiceManagerKind();
  const runner = context.runner ?? defaultCommandRunner;
  const base = {
    config: context.config,
    cliEntrypoint: context.cliEntrypoint,
    runner,
  };

  switch (kind) {
    case "systemd-user":
      return createSystemdUserManager(base);
    case "launchd":
      return createLaunchdManager(base);
    case "windows-task-scheduler":
    case "wsl-task-scheduler-fallback":
      return createWindowsTaskManager(base, kind);
    default:
      return createUnsupportedManager(base.config);
  }
}

export async function restartServiceIfRunning(
  manager: ServiceManager,
): Promise<{ restarted: boolean; message?: string }> {
  const status = await manager.status();
  if (!status.installed || !status.running) {
    return {
      restarted: false,
      message: status.installed
        ? "Config saved. DevSpace service is installed but not running; changes will apply on next start."
        : "Config saved. Changes will apply the next time DevSpace starts.",
    };
  }

  const result = await manager.restart();
  if (!result.ok) {
    throw new Error(`Config saved, but automatic service restart failed: ${result.message}`);
  }

  return { restarted: true };
}

export function detectServiceManagerKind(options: DetectServiceManagerOptions = {}): ServiceManagerKind {
  const currentPlatform = options.platform ?? platform();
  const env = options.env ?? process.env;

  if (currentPlatform === "darwin") return "launchd";
  if (currentPlatform === "win32") return "windows-task-scheduler";
  if (env.WSL_DISTRO_NAME) {
    return hasSystemdUserSession(env) ? "systemd-user" : "wsl-task-scheduler-fallback";
  }
  if (currentPlatform === "linux") {
    return hasSystemdUserSession(env) ? "systemd-user" : "unsupported";
  }
  return "unsupported";
}

function hasSystemdUserSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SYSTEMD_EXEC_PID || env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS);
}

function createUnsupportedManager(config: ServerConfig): ServiceManager {
  return {
    kind: "unsupported",
    serviceName: "devspace",
    async isSupported() {
      return false;
    },
    async remove() {
      return { ok: false, manager: "unsupported", message: unsupportedMessage() };
    },
    async disable() {
      return { ok: false, manager: "unsupported", message: unsupportedMessage() };
    },
    async start() {
      return { ok: false, manager: "unsupported", message: unsupportedMessage() };
    },
    async stop() {
      return { ok: false, manager: "unsupported", message: unsupportedMessage() };
    },
    async restart() {
      return { ok: false, manager: "unsupported", message: unsupportedMessage() };
    },
    async status() {
      return baseStatus("unsupported", "devspace", config);
    },
    async logs() {
      throw new Error(unsupportedMessage());
    },
    async doctor() {
      return {
        manager: "unsupported",
        checks: [{ level: "warn", message: unsupportedMessage() }],
      };
    },
  };
}

function createSystemdUserManager(context: Required<ManagerContext>): ServiceManager {
  const unitPath = join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE_NAME);
  return {
    kind: "systemd-user",
    serviceName: SYSTEMD_SERVICE_NAME,
    async isSupported() {
      const result = await context.runner.exec("systemctl", ["--user", "--version"]);
      return result.exitCode === 0;
    },
    async remove() {
      await context.runner.exec("systemctl", ["--user", "disable", SYSTEMD_SERVICE_NAME]);
      await context.runner.exec("systemctl", ["--user", "stop", SYSTEMD_SERVICE_NAME]);
      if (existsSync(unitPath)) {
        rmSync(unitPath, { force: true });
      }
      await context.runner.exec("systemctl", ["--user", "daemon-reload"]);
      return {
        ok: true,
        manager: "systemd-user",
        message: `Uninstalled ${SYSTEMD_SERVICE_NAME}`,
      };
    },
    async disable() {
      return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "disable", SYSTEMD_SERVICE_NAME], "Disabled service");
    },
    async start() {
      const installed = existsSync(unitPath);
      if (!installed) {
        mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
        mkdirSync(devspaceLogDir(), { recursive: true });
        writeFileSync(unitPath, buildSystemdUnit({ cliEntrypoint: context.cliEntrypoint, config: context.config }), "utf8");
        await context.runner.exec("systemctl", ["--user", "daemon-reload"]);
        await context.runner.exec("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME]);
        return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "restart", SYSTEMD_SERVICE_NAME], "Installed and started service");
      }
      return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "start", SYSTEMD_SERVICE_NAME], "Started service");
    },
    async stop() {
      return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "stop", SYSTEMD_SERVICE_NAME], "Stopped service");
    },
    async restart() {
      return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "restart", SYSTEMD_SERVICE_NAME], "Restarted service");
    },
    async status() {
      const installed = existsSync(unitPath);
      const enabled = installed && (await context.runner.exec("systemctl", ["--user", "is-enabled", SYSTEMD_SERVICE_NAME])).exitCode === 0;
      const running = installed && (await context.runner.exec("systemctl", ["--user", "is-active", SYSTEMD_SERVICE_NAME])).exitCode === 0;
      return {
        ...baseStatus("systemd-user", SYSTEMD_SERVICE_NAME, context.config),
        installed,
        enabled,
        running,
        logPath: join(devspaceLogDir(), "devspace.out.log"),
      };
    },
    async logs(options) {
      const logPath = join(devspaceLogDir(), "devspace.out.log");
      return readLog(logPath, options?.tail);
    },
    async doctor() {
      const status = await this.status();
      return {
        manager: "systemd-user",
        checks: [
          {
            level: (await this.isSupported()) ? "pass" : "warn",
            message: (await this.isSupported()) ? "systemd user service is available" : "systemd user service is unavailable",
          },
          {
            level: status.installed ? "pass" : "info",
            message: status.installed ? "DevSpace unit is installed" : "DevSpace unit is not installed",
          },
          {
            level: status.running ? "pass" : "warn",
            message: status.running ? "DevSpace service is running" : "DevSpace service is not running",
          },
        ],
      };
    },
  };
}

function createLaunchdManager(context: Required<ManagerContext>): ServiceManager {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return {
    kind: "launchd",
    serviceName: LAUNCHD_LABEL,
    async isSupported() {
      return true;
    },
    async remove() {
      await context.runner.exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
      if (existsSync(plistPath)) {
        rmSync(plistPath, { force: true });
      }
      return { ok: true, manager: "launchd", message: "Uninstalled service" };
    },
    async disable() {
      return execServiceResult(context.runner, "launchd", "launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], "Disabled service");
    },
    async start() {
      if (!existsSync(plistPath)) {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        mkdirSync(devspaceLogDir(), { recursive: true });
        writeFileSync(plistPath, buildLaunchAgentPlist({ cliEntrypoint: context.cliEntrypoint, config: context.config }), "utf8");
        const bootstrap = await context.runner.exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath]);
        if (bootstrap.exitCode !== 0 && !bootstrap.stderr.includes("already bootstrapped")) {
          return {
            ok: false,
            manager: "launchd",
            message: [
              "LaunchAgent file was written, but launchctl could not start it.",
              bootstrap.stderr.trim() || bootstrap.stdout.trim() || "Failed to bootstrap LaunchAgent.",
            ].filter(Boolean).join(" "),
          };
        }
        return { ok: true, manager: "launchd", message: "Installed and started service" };
      }
      const kickstart = await context.runner.exec("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
      if (kickstart.exitCode === 0) {
        return { ok: true, manager: "launchd", message: "Started service" };
      }
      return execServiceResult(context.runner, "launchd", "launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath], "Started service");
    },
    async stop() {
      return execServiceResult(context.runner, "launchd", "launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], "Stopped service");
    },
    async restart() {
      if (!existsSync(plistPath)) {
        return { ok: false, manager: "launchd", message: "LaunchAgent is not installed" };
      }
      const result = await context.runner.exec("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
      if (result.exitCode === 0) {
        return { ok: true, manager: "launchd", message: "Restarted service" };
      }
      await this.stop();
      return this.start();
    },
    async status() {
      const installed = existsSync(plistPath);
      const result = installed
        ? await context.runner.exec("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`])
        : { stdout: "", stderr: "", exitCode: 1 };
      return {
        ...baseStatus("launchd", LAUNCHD_LABEL, context.config),
        installed,
        enabled: installed,
        running: result.exitCode === 0,
        logPath: join(devspaceLogDir(), "devspace.out.log"),
      };
    },
    async logs(options) {
      return readLog(join(devspaceLogDir(), "devspace.out.log"), options?.tail);
    },
    async doctor() {
      const status = await this.status();
      return {
        manager: "launchd",
        checks: [
          { level: "pass", message: "launchd is available" },
          {
            level: status.installed ? "pass" : "info",
            message: status.installed ? "LaunchAgent is installed" : "LaunchAgent is not installed",
          },
          {
            level: status.running ? "pass" : "warn",
            message: status.running ? "DevSpace service is running" : "DevSpace service is not running",
          },
          {
            level: existsSync(devspaceLogDir()) ? "pass" : "warn",
            message: existsSync(devspaceLogDir()) ? "Log directory is available" : "Log directory is missing",
          },
        ],
      };
    },
  };
}

function createWindowsTaskManager(
  context: Required<ManagerContext>,
  kind: "windows-task-scheduler" | "wsl-task-scheduler-fallback",
): ServiceManager {
  return {
    kind,
    serviceName: WINDOWS_TASK_NAME,
    async isSupported() {
      const result = await context.runner.exec("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME]);
      return result.exitCode === 0 || result.exitCode === 1;
    },
    async remove() {
      return execServiceResult(context.runner, kind, "schtasks.exe", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME], `Deleted task ${WINDOWS_TASK_NAME}`);
    },
    async disable() {
      return execServiceResult(context.runner, kind, "schtasks.exe", ["/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE"], "Disabled task");
    },
    async start() {
      const installed = (await context.runner.exec("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME])).exitCode === 0;
      if (!installed) {
        const spec = buildServiceCommand(context.cliEntrypoint);
        const taskCommand = `"${spec.command}" ${spec.args.map(windowsQuote).join(" ")}`;
        const created = await execServiceResult(
          context.runner,
          kind,
          "schtasks.exe",
          ["/Create", "/F", "/SC", "ONLOGON", "/TN", WINDOWS_TASK_NAME, "/TR", taskCommand],
          `Installed task ${WINDOWS_TASK_NAME}`,
        );
        if (!created.ok) return created;
        return execServiceResult(context.runner, kind, "schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME], "Installed and started task");
      }
      return execServiceResult(context.runner, kind, "schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME], "Started task");
    },
    async stop() {
      return execServiceResult(context.runner, kind, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], "Stopped task");
    },
    async restart() {
      await this.stop();
      return this.start();
    },
    async status() {
      const result = await context.runner.exec("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
      const installed = result.exitCode === 0;
      const running = /Status:\s+Running/i.test(result.stdout);
      const enabled = !/Scheduled Task State:\s+Disabled/i.test(result.stdout);
      return {
        ...baseStatus(kind, WINDOWS_TASK_NAME, context.config),
        installed,
        enabled: installed && enabled,
        running: installed && running,
        logPath: join(devspaceLogDir(), "devspace.out.log"),
      };
    },
    async logs(options) {
      return readLog(join(devspaceLogDir(), "devspace.out.log"), options?.tail);
    },
    async doctor() {
      const status = await this.status();
      return {
        manager: kind,
        checks: [
          {
            level: status.installed ? "pass" : "info",
            message: status.installed ? "Scheduled task is installed" : "Scheduled task is not installed",
          },
          {
            level: status.running ? "pass" : "warn",
            message: status.running ? "DevSpace task is running" : "DevSpace task is not running",
          },
        ],
      };
    },
  };
}

function baseStatus(kind: ServiceManagerKind, serviceName: string, config: ServerConfig): ServiceStatus {
  return {
    installed: false,
    enabled: false,
    running: false,
    manager: kind,
    serviceName,
    endpoint: new URL(config.mcpPath, `http://${config.host}:${config.port}`).toString(),
    publicBaseUrl: config.publicBaseUrl,
  };
}

async function execServiceResult(
  runner: CommandRunner,
  manager: ServiceManagerKind,
  command: string,
  args: string[],
  successMessage: string,
): Promise<ServiceResult> {
  const result = await runner.exec(command, args);
  return result.exitCode === 0
    ? { ok: true, manager, message: successMessage }
    : { ok: false, manager, message: result.stderr.trim() || result.stdout.trim() || successMessage };
}

async function readLog(path: string, tail?: number): Promise<string> {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  if (tail === undefined) return content;
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - tail)).join("\n");
}

function unsupportedMessage(): string {
  return "DevSpace service management is not supported on this platform.";
}

function windowsQuote(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
