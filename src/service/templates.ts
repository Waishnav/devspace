import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { devspaceConfigDir } from "../user-config.js";

export interface ServiceCommandSpec {
  command: string;
  args: string[];
}

export function devspaceLogDir(): string {
  return join(devspaceConfigDir(), "logs");
}

export function buildServiceCommand(cliEntrypoint: string): ServiceCommandSpec {
  return {
    command: process.execPath,
    args: [cliEntrypoint, "service-run"],
  };
}

export function buildServiceEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  const allowed = ["DEVSPACE_CONFIG_DIR", "PATH"];

  for (const key of allowed) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }

  if (!environment.DEVSPACE_CONFIG_DIR) {
    environment.DEVSPACE_CONFIG_DIR = join(homedir(), ".devspace");
  }

  return environment;
}

export function buildSystemdUnit(options: {
  cliEntrypoint: string;
  config: ServerConfig;
}): string {
  const spec = buildServiceCommand(options.cliEntrypoint);
  const logDir = devspaceLogDir();
  const execStart = [spec.command, ...spec.args].map(escapeSystemdArg).join(" ");
  const environment = buildServiceEnvironment();

  return [
    "[Unit]",
    "Description=DevSpace MCP Server",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    ...Object.entries(environment).map(([key, value]) => `Environment=${key}=${escapeEnvValue(value)}`),
    `StandardOutput=append:${join(logDir, "devspace.out.log")}`,
    `StandardError=append:${join(logDir, "devspace.err.log")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function buildLaunchAgentPlist(options: {
  cliEntrypoint: string;
  config: ServerConfig;
  label?: string;
}): string {
  const spec = buildServiceCommand(options.cliEntrypoint);
  const logDir = devspaceLogDir();
  const label = options.label ?? "com.devspace.server";
  const environment = buildServiceEnvironment();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
      ${[spec.command, ...spec.args].map((arg) => `<string>${xmlEscape(arg)}</string>`).join("\n      ")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
      ${Object.entries(environment).map(([key, value]) => `<key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`).join("\n      ")}
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(logDir, "devspace.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(logDir, "devspace.err.log"))}</string>
  </dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeEnvValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeSystemdArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
