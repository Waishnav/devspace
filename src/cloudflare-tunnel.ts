// Automatic Cloudflare quick-tunnel support for DevSpace.
//
// Locates a `cloudflared` binary (PATH, then a local install under
// ~/.devspace/bin), auto-installing the official release when missing, then
// starts a quick tunnel and scrapes the generated https://*.trycloudflare.com
// URL from cloudflared's output. This lets `devspace serve` expose itself
// publicly without the user having to run a separate tunnel command.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// When DevSpace drives the tunnel behind a clack spinner it sets quiet mode so
// our own progress lines don't fight the spinner animation.
let QUIET = false;
function status(message: string): void {
  if (!QUIET) console.log(message);
}

function cloudflaredBinName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function devspaceHome(): string {
  return process.env.DEVSPACE_CONFIG_DIR
    ? process.env.DEVSPACE_CONFIG_DIR
    : join(homedir(), ".devspace");
}

function localCloudflaredPath(): string {
  return join(devspaceHome(), "bin", cloudflaredBinName());
}

interface ReleaseAsset {
  file: string;
  archive: boolean;
}

function cloudflaredReleaseAsset(): ReleaseAsset {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    if (arch === "arm64") return { file: "cloudflared-darwin-arm64.tgz", archive: true };
    if (arch === "x64") return { file: "cloudflared-darwin-amd64.tgz", archive: true };
  }
  if (platform === "linux") {
    if (arch === "arm64") return { file: "cloudflared-linux-arm64", archive: false };
    if (arch === "arm") return { file: "cloudflared-linux-arm", archive: false };
    if (arch === "x64") return { file: "cloudflared-linux-amd64", archive: false };
    if (arch === "ia32") return { file: "cloudflared-linux-386", archive: false };
  }
  if (platform === "win32") {
    if (arch === "x64") return { file: "cloudflared-windows-amd64.exe", archive: false };
    if (arch === "ia32") return { file: "cloudflared-windows-386.exe", archive: false };
  }
  throw new Error(
    `Automatic cloudflared install is not supported on ${platform}/${arch}. ` +
      "Install cloudflared manually and set CLOUDFLARED_BIN, or use a manual public URL.",
  );
}

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore", shell: false });
  return result.status === 0;
}

function verifyCloudflared(binaryPath: string): boolean {
  const result = spawnSync(binaryPath, ["--version"], {
    stdio: "ignore",
    shell: false,
    timeout: 15000,
  });
  return result.status === 0;
}

function findFileByName(root: string, fileName: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return "";
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { headers: { "user-agent": "devspace-launcher" } });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer, { mode: 0o755 });
}

async function installCloudflaredLocal(): Promise<string> {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = dirname(installPath);
  const tmpRoot = mkdtempSync(join(tmpdir(), "devspace-cloudflared-"));
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  status(`devspace: installing cloudflared locally at ${installPath}`);
  status(`devspace: downloading official Cloudflare release ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = join(tmpRoot, asset.file);
      const extractDir = join(tmpRoot, "extract");
      mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath);
      const tar = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (tar.status !== 0) {
        throw new Error(
          `Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`,
        );
      }
      const extracted = findFileByName(extractDir, "cloudflared");
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary);
      copyFileSync(tmpBinary, installPath);
    }
    spawnSync("chmod", ["+x", installPath], { stdio: "ignore", shell: false });
    if (!verifyCloudflared(installPath)) {
      throw new Error(`Downloaded cloudflared, but ${installPath} --version failed.`);
    }
    status("devspace: cloudflared installed successfully.");
    return installPath;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// Resolve a usable cloudflared binary, installing one when necessary.
export async function resolveCloudflared(): Promise<string> {
  const explicit = process.env.CLOUDFLARED_BIN?.trim();
  if (explicit) {
    if (verifyCloudflared(explicit)) return explicit;
    throw new Error(`CLOUDFLARED_BIN is set to ${explicit}, but it failed --version.`);
  }
  if (commandExists("cloudflared") && verifyCloudflared("cloudflared")) {
    return "cloudflared";
  }
  const localPath = localCloudflaredPath();
  if (existsSync(localPath) && verifyCloudflared(localPath)) {
    return localPath;
  }
  return installCloudflaredLocal();
}

const TRYCLOUDFLARE_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;

function waitForCloudflareUrl(child: ChildProcess, timeoutMs = 45000): Promise<string> {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for cloudflared public URL.")),
      timeoutMs,
    );
    timer.unref?.();
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const match = buffer.match(TRYCLOUDFLARE_RE);
      if (match?.[0]) {
        clearTimeout(timer);
        cleanup();
        resolve(match[0]);
      }
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`cloudflared exited before a URL was found (code=${code}).`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

export interface QuickTunnel {
  publicBaseUrl: string;
  child: ChildProcess;
  stop: () => void;
}

export interface StartQuickTunnelOptions {
  quiet?: boolean;
}

// Start a Cloudflare quick tunnel pointing at the given local origin.
export async function startQuickTunnel(
  localBaseUrl: string,
  options: StartQuickTunnelOptions = {},
): Promise<QuickTunnel> {
  QUIET = options.quiet === true;
  const cloudflaredPath = await resolveCloudflared();
  status("devspace: opening Cloudflare quick tunnel...");
  const child = spawn(cloudflaredPath, ["tunnel", "--url", localBaseUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => {
    console.error(
      `devspace: cloudflared failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const publicBaseUrl = await waitForCloudflareUrl(child);
  const stop = () => {
    if (child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 1500).unref?.();
  };
  return { publicBaseUrl, child, stop };
}
