import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const LOCAL_AGENT_DAEMON_PROTOCOL_VERSION = 3;
export const LOCAL_AGENT_DAEMON_SOCKET_NAME = "agentd.sock";
export const LOCAL_AGENT_DAEMON_PID_NAME = "agentd.pid";
export const LOCAL_AGENT_DAEMON_LOCK_NAME = "agentd.lock";
export const LOCAL_AGENT_DAEMON_SECRET_NAME = "agentd.secret";
export const LOCAL_AGENT_DAEMON_LOG_NAME = "agentd.log";

export interface LocalAgentDaemonPaths {
  stateDir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  secretPath: string;
  logPath: string;
  endpoint: string;
}

export function localAgentDaemonPaths(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): LocalAgentDaemonPaths {
  const resolvedStateDir = resolve(stateDir);
  const socketPath = join(resolvedStateDir, LOCAL_AGENT_DAEMON_SOCKET_NAME);
  return {
    stateDir: resolvedStateDir,
    socketPath,
    pidPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_PID_NAME),
    lockPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_LOCK_NAME),
    secretPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_SECRET_NAME),
    logPath: join(resolvedStateDir, LOCAL_AGENT_DAEMON_LOG_NAME),
    endpoint: platform === "win32"
      ? `\\\\.\\pipe\\devspace-agentd-${hashStateDir(resolvedStateDir)}`
      : socketPath,
  };
}

export function ensureLocalAgentDaemonStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

export class LocalAgentDaemonAlreadyRunningError extends Error {
  readonly code = "DAEMON_ALREADY_RUNNING" as const;

  constructor(readonly pid?: number) {
    super(pid ? `Local agent daemon is already running (pid ${pid}).` : "Local agent daemon is already running.");
    this.name = "LocalAgentDaemonAlreadyRunningError";
  }
}

export class LocalAgentDaemonLock {
  private acquired = false;

  constructor(readonly paths: LocalAgentDaemonPaths) {}

  acquire(): void {
    ensureLocalAgentDaemonStateDir(this.paths.stateDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const temporaryPath = `${this.paths.lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      let published = false;
      try {
        writeFileSecure(temporaryPath, `${process.pid}\n`);
        // Publish the owner record atomically. An empty lock must never be
        // visible to stale-lock recovery between create and write.
        linkSync(temporaryPath, this.paths.lockPath);
        published = true;
        rmSync(temporaryPath, { force: true });
        chmodSync(this.paths.lockPath, 0o600);
        writeFileSecure(this.paths.pidPath, `${process.pid}\n`);
        this.acquired = true;
        return;
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (published && readDaemonPid(this.paths.lockPath) === process.pid) {
          rmSync(this.paths.lockPath, { force: true });
        }
        if (!isFileExistsError(error)) throw error;
        const pid = readDaemonPid(this.paths.lockPath);
        if (pid !== undefined && isProcessAlive(pid)) {
          throw new LocalAgentDaemonAlreadyRunningError(pid);
        }
        if (pid === undefined) {
          // An undecodable lock may belong to a process that has not finished
          // publishing its owner record. Refuse to delete it automatically.
          throw new LocalAgentDaemonAlreadyRunningError();
        }
        if (!removeStaleLock(this.paths.lockPath)) continue;
      }
    }
    throw new LocalAgentDaemonAlreadyRunningError(readDaemonPid(this.paths.lockPath));
  }

  release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    if (readDaemonPid(this.paths.pidPath) === process.pid) {
      rmSync(this.paths.pidPath, { force: true });
    }
    if (readDaemonPid(this.paths.lockPath) === process.pid) {
      rmSync(this.paths.lockPath, { force: true });
    }
  }
}

export function writeLocalAgentDaemonPid(paths: LocalAgentDaemonPaths): void {
  writeFileSecure(paths.pidPath, `${process.pid}\n`);
}

export function ensureLocalAgentDaemonSecret(paths: LocalAgentDaemonPaths): string {
  ensureLocalAgentDaemonStateDir(paths.stateDir);
  try {
    const secret = readFileSync(paths.secretPath, "utf8").trim();
    if (isDaemonSecret(secret)) return secret;
  } catch {
    // Create the secret below.
  }

  const secret = randomBytes(32).toString("hex");
  try {
    const fileDescriptor = openSync(paths.secretPath, "wx", 0o600);
    try {
      writeSync(fileDescriptor, `${secret}\n`);
      chmodSync(paths.secretPath, 0o600);
      return secret;
    } finally {
      closeSync(fileDescriptor);
    }
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const existing = readFileSync(paths.secretPath, "utf8").trim();
    if (!isDaemonSecret(existing)) throw new Error("Local agent daemon secret is invalid.");
    return existing;
  }
}

export function readLocalAgentDaemonSecret(paths: LocalAgentDaemonPaths): string | undefined {
  try {
    const secret = readFileSync(paths.secretPath, "utf8").trim();
    return isDaemonSecret(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

export function removeLocalAgentDaemonFiles(paths: LocalAgentDaemonPaths): void {
  rmSync(paths.pidPath, { force: true });
  if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
}

export function readDaemonPid(pidPath: string): number | undefined {
  try {
    const value = readFileSync(pidPath, "utf8").trim();
    if (!/^\d+$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeFileSecure(path: string, content: string): void {
  const fileDescriptor = openSync(path, "w", 0o600);
  try {
    writeSync(fileDescriptor, content);
    chmodSync(path, 0o600);
  } finally {
    closeSync(fileDescriptor);
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function removeStaleLock(path: string): boolean {
  const stalePath = `${path}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    // Rename moves the exact lock we inspected out of the ownership path. If
    // another contender publishes a new lock after this point, it is never
    // removed with the stale one.
    renameSync(path, stalePath);
    rmSync(stalePath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isDaemonSecret(secret: string): boolean {
  return /^[0-9a-f]{64}$/i.test(secret);
}

function hashStateDir(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
}
