import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { TunnelMode } from "./user-config.js";

const TRYCLOUDFLARE_URL_RE = /https:\/\/([a-zA-Z0-9-]+)\.trycloudflare\.com\b/g;

export interface QuickTunnel {
  publicBaseUrl: string;
  child: ChildProcess;
  stop: () => void;
}

export interface StartQuickTunnelOptions {
  quiet?: boolean;
  timeoutMs?: number;
}

export interface CloudflareSpawnCommand {
  command: string;
  args: string[];
}

export interface TunnelModeOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  configuredTunnel?: TunnelMode;
}

export function resolveTunnelMode(options: TunnelModeOptions = {}): TunnelMode | undefined {
  const args = options.args ?? [];
  if (args.includes("--no-tunnel")) return undefined;
  if (args.includes("--tunnel") || args.includes("--tunnel=cloudflare")) return "cloudflare";

  const envTunnel = options.env?.DEVSPACE_TUNNEL?.trim().toLowerCase();
  if (envTunnel === "cloudflare") return "cloudflare";
  if (envTunnel === "none" || envTunnel === "off") return undefined;

  return options.configuredTunnel;
}

export function extractTryCloudflareUrl(output: string): string | undefined {
  const match = TRYCLOUDFLARE_URL_RE.exec(output);
  TRYCLOUDFLARE_URL_RE.lastIndex = 0;
  return match ? `https://${match[1]}.trycloudflare.com` : undefined;
}

export function buildCloudflareTunnelCommand(
  cloudflaredPath: string,
  localBaseUrl: string,
): CloudflareSpawnCommand {
  return {
    command: cloudflaredPath,
    args: ["tunnel", "--url", localBaseUrl, "--no-autoupdate"],
  };
}

export function resolveCloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CLOUDFLARED_BIN?.trim();
  if (explicit) {
    if (verifyCloudflared(explicit)) return explicit;
    throw new Error(`CLOUDFLARED_BIN is set to ${explicit}, but it failed --version.`);
  }

  if (verifyCloudflared("cloudflared")) return "cloudflared";
  throw new Error(
    "Cloudflare tunnel mode requires an installed cloudflared binary. " +
      "Install cloudflared or set CLOUDFLARED_BIN to an existing executable.",
  );
}

export async function startQuickTunnel(
  localBaseUrl: string,
  options: StartQuickTunnelOptions = {},
): Promise<QuickTunnel> {
  const cloudflaredPath = resolveCloudflaredBinary();
  const command = buildCloudflareTunnelCommand(cloudflaredPath, localBaseUrl);
  const child = spawn(command.command, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  try {
    const publicBaseUrl = await waitForCloudflareUrl(child, options.timeoutMs ?? 45_000);
    if (!options.quiet) {
      console.log(`devspace: Cloudflare quick tunnel ready at ${publicBaseUrl}`);
    }

    return {
      publicBaseUrl,
      child,
      stop: () => stopChildProcess(child),
    };
  } catch (error) {
    stopChildProcess(child);
    throw error;
  }
}

function verifyCloudflared(binaryPath: string): boolean {
  if (binaryPath !== "cloudflared" && !existsSync(binaryPath)) return false;

  const result = spawnSync(binaryPath, ["--version"], {
    stdio: "ignore",
    shell: false,
    timeout: 15_000,
  });
  return result.status === 0;
}

function waitForCloudflareUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  let output = "";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
    };

    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      const publicBaseUrl = extractTryCloudflareUrl(output);
      if (!publicBaseUrl) return;

      cleanup();
      resolve(publicBaseUrl);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`cloudflared exited before publishing a tunnel URL (code=${code}, signal=${signal ?? "none"}).`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for cloudflared to publish a trycloudflare URL."));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

function stopChildProcess(child: ChildProcess): void {
  if (child.killed) return;

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    if (child.killed) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore cleanup failures
    }
  }, 1_500).unref?.();
}
