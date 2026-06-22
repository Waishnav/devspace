import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  managerKindOverride?: ServiceManagerKind;
  pathsOverride?: Partial<ServiceManagerPaths>;
}

interface DetectServiceManagerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hasSystemdRuntimeMarkers?: boolean;
}

interface ServiceManagerPaths {
  userSystemdUnitPath: string;
  launchdPlistPath: string;
}

interface CliEntrypointHealth {
  currentEntrypoint: string;
  managedEntrypoint?: string;
  sourceBound: boolean;
  managedExists: boolean;
  message?: string;
}

interface NormalizedManagerContext {
  config: ServerConfig;
  cliEntrypoint: string;
  managedCliEntrypoint: string;
  cliHealth: CliEntrypointHealth;
  runner: CommandRunner;
  paths: ServiceManagerPaths;
}

interface ExistingSystemdUnitState {
  installed: boolean;
  content?: string;
  execEntrypoint?: string;
}

interface ExistingLaunchdState {
  installed: boolean;
  content?: string;
  execEntrypoint?: string;
}

interface SystemdRuntimeDetails {
  environment: string;
  mainPid?: number;
}

export function createServiceManager(context: ManagerContext): ServiceManager {
  const kind = context.managerKindOverride ?? detectServiceManagerKind();
  const runner = context.runner ?? defaultCommandRunner;
  const paths = resolveServiceManagerPaths(context.pathsOverride);
  const cliHealth = inspectCliEntrypoint(context.cliEntrypoint);
  const managedCliEntrypoint = cliHealth.managedEntrypoint ?? context.cliEntrypoint;
  const base: NormalizedManagerContext = {
    config: context.config,
    cliEntrypoint: context.cliEntrypoint,
    managedCliEntrypoint,
    cliHealth,
    runner,
    paths,
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
  const systemdRuntimeMarkers = options.hasSystemdRuntimeMarkers ?? hasSystemdRuntimeMarkers();

  if (currentPlatform === "darwin") return "launchd";
  if (currentPlatform === "win32") return "windows-task-scheduler";
  if (env.WSL_DISTRO_NAME) {
    return hasSystemdUserSession(env) ? "systemd-user" : "wsl-task-scheduler-fallback";
  }
  if (currentPlatform === "linux") {
    return hasSystemdUserSession(env) || systemdRuntimeMarkers
      ? "systemd-user"
      : "unsupported";
  }
  return "unsupported";
}

function hasSystemdUserSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SYSTEMD_EXEC_PID || env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS);
}

function hasSystemdRuntimeMarkers(): boolean {
  return existsSync("/run/systemd/system") || existsSync(`/run/user/${process.getuid?.() ?? 0}`);
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

function createSystemdUserManager(context: NormalizedManagerContext): ServiceManager {
  const unitPath = context.paths.userSystemdUnitPath;
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
      return installOrStartSystemdUserService(context, "start");
    },
    async stop() {
      return execServiceResult(context.runner, "systemd-user", "systemctl", ["--user", "stop", SYSTEMD_SERVICE_NAME], "Stopped service");
    },
    async restart() {
      return installOrStartSystemdUserService(context, "restart");
    },
    async status() {
      const installed = existsSync(unitPath);
      const enabled = installed && (await context.runner.exec("systemctl", ["--user", "is-enabled", SYSTEMD_SERVICE_NAME])).exitCode === 0;
      const running = installed && (await context.runner.exec("systemctl", ["--user", "is-active", SYSTEMD_SERVICE_NAME])).exitCode === 0;
      const existing = readSystemdUnitState(unitPath);
      const runtime = installed ? await readSystemdRuntimeDetails(context.runner) : emptySystemdRuntimeDetails();
      return {
        ...baseStatus("systemd-user", SYSTEMD_SERVICE_NAME, context.config),
        installed,
        enabled,
        running,
        logPath: join(devspaceLogDir(), "devspace.out.log"),
        pid: runtime.mainPid,
        details: {
          installedEntrypoint: existing.execEntrypoint ?? "(unknown)",
          runtimeEnvironmentOverride:
            runtime.environment.includes("DEVSPACE_ALLOWED_ROOTS=")
            || runtime.environment.includes("DEVSPACE_SESSION_WORKSPACE="),
        },
      };
    },
    async logs(options) {
      const logPath = join(devspaceLogDir(), "devspace.out.log");
      return readLog(logPath, options?.tail);
    },
    async doctor() {
      const entrypointCheck = cliEntrypointDoctorCheck(context.cliHealth);
      const status = await this.status();
      const existing = readSystemdUnitState(unitPath);
      const checks: ServiceDoctorResult["checks"] = [
        {
          level: (await this.isSupported()) ? "pass" : "warn",
          message: (await this.isSupported()) ? "systemd user service is available" : "systemd user service is unavailable",
        },
      ];
      if (entrypointCheck) checks.push(entrypointCheck);
      checks.push(
        {
          level: status.installed ? "pass" : "info",
          message: status.installed ? "DevSpace unit is installed" : "DevSpace unit is not installed",
        },
        {
          level: status.running ? "pass" : "warn",
          message: status.running ? "DevSpace service is running" : "DevSpace service is not running",
        },
      );
      if (
        existing.installed
        && existing.execEntrypoint
        && existing.execEntrypoint !== context.managedCliEntrypoint
      ) {
        checks.push({
          level: "warn",
          message: `Installed unit points to ${existing.execEntrypoint} instead of ${context.managedCliEntrypoint}. Run \`devspace service start\` to repair it.`,
        });
      }
      if (existing.installed && existing.execEntrypoint && !existsSync(existing.execEntrypoint)) {
        checks.push({
          level: "error",
          message: `Installed unit points to a missing CLI entrypoint: ${existing.execEntrypoint}.`,
        });
      }
      if (status.details?.runtimeEnvironmentOverride) {
        checks.push({
          level: "error",
          message: "Running service environment still contains temporary workspace override variables. Re-run `devspace service start` to rewrite the service definition.",
        });
      }
      return {
        manager: "systemd-user",
        checks,
      };
    },
  };
}

function createLaunchdManager(context: NormalizedManagerContext): ServiceManager {
  const plistPath = context.paths.launchdPlistPath;
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
      const validation = validateManagedCliEntrypoint(context.cliHealth, "launchd");
      if (validation) return validation;

      const expected = buildLaunchAgentPlist({
        cliEntrypoint: context.managedCliEntrypoint,
        config: context.config,
      });
      const existing = readLaunchdState(plistPath);
      const needsRewrite = !existing.installed || existing.content !== expected;

      if (needsRewrite) {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        mkdirSync(devspaceLogDir(), { recursive: true });
        writeFileSync(plistPath, expected, "utf8");
        if (existing.installed) {
          await context.runner.exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
        }
        const bootstrap = await context.runner.exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath]);
        if (
          bootstrap.exitCode !== 0
          && !bootstrap.stderr.includes("already bootstrapped")
          && !bootstrap.stderr.includes("service already loaded")
        ) {
          return {
            ok: false,
            manager: "launchd",
            message: [
              "LaunchAgent file was written, but launchctl could not start it.",
              bootstrap.stderr.trim() || bootstrap.stdout.trim() || "Failed to bootstrap LaunchAgent.",
            ].filter(Boolean).join(" "),
          };
        }
      }
      const kickstart = await context.runner.exec("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
      if (kickstart.exitCode === 0) {
        return {
          ok: true,
          manager: "launchd",
          message: needsRewrite ? "Installed and started service" : "Started service",
        };
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
      const existing = readLaunchdState(plistPath);
      const result = existing.installed
        ? await context.runner.exec("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`])
        : { stdout: "", stderr: "", exitCode: 1 };
      return {
        ...baseStatus("launchd", LAUNCHD_LABEL, context.config),
        installed: existing.installed,
        enabled: existing.installed,
        running: result.exitCode === 0,
        logPath: join(devspaceLogDir(), "devspace.out.log"),
        details: {
          installedEntrypoint: existing.execEntrypoint ?? "(unknown)",
        },
      };
    },
    async logs(options) {
      return readLog(join(devspaceLogDir(), "devspace.out.log"), options?.tail);
    },
    async doctor() {
      const entrypointCheck = cliEntrypointDoctorCheck(context.cliHealth);
      const status = await this.status();
      const existing = readLaunchdState(plistPath);
      const checks: ServiceDoctorResult["checks"] = [
        { level: "pass", message: "launchd is available" },
      ];
      if (entrypointCheck) checks.push(entrypointCheck);
      checks.push(
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
      );
      if (
        existing.installed
        && existing.execEntrypoint
        && existing.execEntrypoint !== context.managedCliEntrypoint
      ) {
        checks.push({
          level: "warn",
          message: `Installed LaunchAgent points to ${existing.execEntrypoint} instead of ${context.managedCliEntrypoint}. Run \`devspace service start\` to repair it.`,
        });
      }
      if (existing.installed && existing.execEntrypoint && !existsSync(existing.execEntrypoint)) {
        checks.push({
          level: "error",
          message: `Installed LaunchAgent points to a missing CLI entrypoint: ${existing.execEntrypoint}.`,
        });
      }
      return {
        manager: "launchd",
        checks,
      };
    },
  };
}

function createWindowsTaskManager(
  context: NormalizedManagerContext,
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
      const validation = validateManagedCliEntrypoint(context.cliHealth, kind);
      if (validation) return validation;
      const installed = (await context.runner.exec("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME])).exitCode === 0;
      if (!installed) {
        const taskCommand = buildWindowsTaskCommand(context.managedCliEntrypoint);
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
    endpoint: new URL(config.mcpPath, config.publicBaseUrl).toString(),
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

function buildWindowsTaskCommand(cliEntrypoint: string): string {
  const spec = buildServiceCommand(cliEntrypoint);
  return `"${spec.command}" ${spec.args.map(windowsQuote).join(" ")}`;
}

function windowsQuote(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function installOrStartSystemdUserService(
  context: NormalizedManagerContext,
  action: "start" | "restart",
): Promise<ServiceResult> {
  return installOrStartSystemdUserServiceImpl(context, action);
}

async function installOrStartSystemdUserServiceImpl(
  context: NormalizedManagerContext,
  action: "start" | "restart",
): Promise<ServiceResult> {
  const validation = validateManagedCliEntrypoint(context.cliHealth, "systemd-user");
  if (validation) return validation;

  const unitPath = context.paths.userSystemdUnitPath;
  const expected = buildSystemdUnit({
    cliEntrypoint: context.managedCliEntrypoint,
    config: context.config,
  });
  const existing = readSystemdUnitState(unitPath);
  const needsRewrite = !existing.installed || existing.content !== expected;

  if (needsRewrite) {
    mkdirSync(dirname(unitPath), { recursive: true });
    mkdirSync(devspaceLogDir(), { recursive: true });
    writeFileSync(unitPath, expected, "utf8");
    await context.runner.exec("systemctl", ["--user", "daemon-reload"]);
    await context.runner.exec("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME]);
  }

  const command = needsRewrite || action === "restart" ? "restart" : "start";
  return execServiceResult(
    context.runner,
    "systemd-user",
    "systemctl",
    ["--user", command, SYSTEMD_SERVICE_NAME],
    needsRewrite
      ? "Installed and started service"
      : command === "restart"
        ? "Restarted service"
        : "Started service",
  );
}

function resolveServiceManagerPaths(overrides: Partial<ServiceManagerPaths> = {}): ServiceManagerPaths {
  return {
    userSystemdUnitPath:
      overrides.userSystemdUnitPath ?? join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE_NAME),
    launchdPlistPath:
      overrides.launchdPlistPath ?? join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  };
}

function inspectCliEntrypoint(cliEntrypoint: string): CliEntrypointHealth {
  const currentEntrypoint = resolve(cliEntrypoint);
  const sourceBound =
    /[/\\]src[/\\]cli\.[cm]?[jt]s$/u.test(currentEntrypoint)
    || currentEntrypoint.includes("/worktrees/")
    || currentEntrypoint.includes("\\worktrees\\");
  const managedEntrypoint = resolveManagedCliEntrypoint(currentEntrypoint);
  const managedExists = managedEntrypoint ? existsSync(managedEntrypoint) : false;

  if (!managedEntrypoint) {
    return {
      currentEntrypoint,
      sourceBound,
      managedExists: false,
      message: `DevSpace could not determine a stable CLI entrypoint from ${currentEntrypoint}.`,
    };
  }

  if (!managedExists) {
    return {
      currentEntrypoint,
      managedEntrypoint,
      sourceBound,
      managedExists: false,
      message: sourceBound
        ? [
            `Current DevSpace CLI is running from source at ${currentEntrypoint}.`,
            `Expected built service entrypoint is ${managedEntrypoint}, but it does not exist.`,
            "Run `npm run build` before starting the background service.",
          ].join(" ")
        : `DevSpace CLI entrypoint does not exist: ${managedEntrypoint}.`,
    };
  }

  return {
    currentEntrypoint,
    managedEntrypoint,
    sourceBound,
    managedExists: true,
  };
}

function resolveManagedCliEntrypoint(cliEntrypoint: string): string | undefined {
  if (/[/\\]dist[/\\]cli\.js$/u.test(cliEntrypoint)) return cliEntrypoint;
  if (/[/\\]src[/\\]cli\.[cm]?[jt]s$/u.test(cliEntrypoint)) {
    return resolve(dirname(dirname(cliEntrypoint)), "dist", "cli.js");
  }
  return cliEntrypoint;
}

function validateManagedCliEntrypoint(
  cliHealth: CliEntrypointHealth,
  manager: ServiceManagerKind,
): ServiceResult | undefined {
  if (cliHealth.managedEntrypoint && cliHealth.managedExists) return undefined;
  return {
    ok: false,
    manager,
    message: cliHealth.message ?? `DevSpace CLI entrypoint is unavailable: ${cliHealth.currentEntrypoint}`,
  };
}

function cliEntrypointDoctorCheck(
  cliHealth: CliEntrypointHealth,
): ServiceDoctorResult["checks"][number] | undefined {
  if (cliHealth.sourceBound) {
    return {
      level: cliHealth.managedExists ? "warn" : "error",
      message: cliHealth.managedExists
        ? `Current DevSpace CLI is running from source. The managed service will bind to ${cliHealth.managedEntrypoint}.`
        : (cliHealth.message ?? "Current DevSpace CLI is running from source, but the built service entrypoint is missing."),
    };
  }

  if (!cliHealth.managedExists) {
    return {
      level: "error",
      message: cliHealth.message ?? `DevSpace CLI entrypoint is missing: ${cliHealth.currentEntrypoint}`,
    };
  }

  return undefined;
}

function readSystemdUnitState(unitPath: string): ExistingSystemdUnitState {
  if (!existsSync(unitPath)) return { installed: false };
  const content = readFileSync(unitPath, "utf8");
  const execStart = content.match(/^ExecStart=(.+)$/m)?.[1];
  const tokens = execStart ? splitCommandLine(execStart) : [];
  return {
    installed: true,
    content,
    execEntrypoint: tokens[1],
  };
}

function readLaunchdState(plistPath: string): ExistingLaunchdState {
  if (!existsSync(plistPath)) return { installed: false };
  const content = readFileSync(plistPath, "utf8");
  const matches = Array.from(content.matchAll(/<string>([^<]+)<\/string>/g)).map((match) => xmlUnescape(match[1] ?? ""));
  const serviceRunIndex = matches.indexOf("service-run");
  return {
    installed: true,
    content,
    execEntrypoint: serviceRunIndex >= 1 ? matches[serviceRunIndex - 1] : undefined,
  };
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < value.length) {
        index += 1;
        current += value[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

async function readSystemdRuntimeDetails(runner: CommandRunner): Promise<SystemdRuntimeDetails> {
  const result = await runner.exec("systemctl", [
    "--user",
    "show",
    SYSTEMD_SERVICE_NAME,
    "--property=Environment",
    "--property=MainPID",
    "--value",
  ]);
  if (result.exitCode !== 0) return emptySystemdRuntimeDetails();
  const [environment = "", mainPidRaw = ""] = result.stdout.split(/\r?\n/);
  const mainPid = Number(mainPidRaw.trim());
  return {
    environment: environment.trim(),
    mainPid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : undefined,
  };
}

function emptySystemdRuntimeDetails(): SystemdRuntimeDetails {
  return { environment: "" };
}
