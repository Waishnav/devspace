import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  SandboxManager,
  type FilesystemConfig,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ExtensionFactory,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import { terminateProcessTree } from "./process-platform.js";

export type PiSandboxWriteMode = "read_only" | "allowed" | "full_access";

export interface PiSandboxModeRef {
  value: PiSandboxWriteMode;
}

interface PiSandboxSessionState {
  workspace: string;
  modeRef: PiSandboxModeRef;
  acquired: boolean;
}

const PI_NETWORK_ALLOWLIST = [
  "npmjs.org",
  "*.npmjs.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "crates.io",
  "*.crates.io",
  "rubygems.org",
  "*.rubygems.org",
] as const;

// Pi does not provide a built-in sandbox. Keep the provider-native sandbox
// small and fail closed when a command needs a registry or host that is not
// explicitly allowed here; the agent can report that limitation to the user.

let sandboxInitialization: Promise<void> | undefined;
let windowsSandboxWorkspace: string | undefined;
let windowsSandboxQueue = Promise.resolve();
let sandboxSessionCount = 0;
let sandboxCommandCount = 0;
const sandboxCommandWaiters = new Set<() => void>();
const sessionStates = new WeakMap<object, PiSandboxSessionState>();

export function createPiSandboxModeRef(value: PiSandboxWriteMode): PiSandboxModeRef {
  return { value };
}

export function createPiSandboxExtension(
  workspace: string,
  modeRef: PiSandboxModeRef,
): ExtensionFactory {
  return (pi) => {
    const localRead = createReadTool(workspace);
    const restrictedRead = createReadTool(workspace, { operations: createReadOperations(workspace) });
    pi.registerTool(dynamicTool(localRead, restrictedRead, modeRef));

    const localWrite = createWriteTool(workspace);
    const restrictedWrite = createWriteTool(workspace, { operations: createWriteOperations(workspace) });
    pi.registerTool(dynamicTool(localWrite, restrictedWrite, modeRef, true));

    const localEdit = createEditTool(workspace);
    const restrictedEdit = createEditTool(workspace, { operations: createEditOperations(workspace) });
    pi.registerTool(dynamicTool(localEdit, restrictedEdit, modeRef, true));

    const localGrep = createGrepTool(workspace);
    const restrictedGrep = createGrepTool(workspace, { operations: createGrepOperations(workspace) });
    pi.registerTool(dynamicTool(localGrep, restrictedGrep, modeRef));

    const localFind = createFindTool(workspace);
    const restrictedFind = createFindTool(workspace, { operations: createFindOperations(workspace) });
    pi.registerTool(dynamicTool(localFind, restrictedFind, modeRef));

    const localLs = createLsTool(workspace);
    const restrictedLs = createLsTool(workspace, { operations: createLsOperations(workspace) });
    pi.registerTool(dynamicTool(localLs, restrictedLs, modeRef));

    const localBash = createBashTool(workspace);
    const restrictedBash = createBashTool(workspace, {
      operations: createSandboxedBashOperations(),
    });
    pi.registerTool(dynamicTool(localBash, restrictedBash, modeRef, true));
  };
}

export function createPiSandboxConfig(workspace?: string): SandboxRuntimeConfig {
  const resolvedWorkspace = workspace ? resolveWorkspace(workspace) : undefined;
  return {
    network: {
      allowedDomains: [...PI_NETWORK_ALLOWLIST],
      deniedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: protectedHomePaths(),
      allowWrite: process.platform === "win32" && resolvedWorkspace ? [resolvedWorkspace] : [],
      denyWrite: resolvedWorkspace
        ? [join(resolvedWorkspace, ".env"), join(resolvedWorkspace, ".env.local")]
        : [],
      allowRead: [],
    },
  };
}

export async function registerPiSandboxSession(
  session: object,
  workspace: string,
  modeRef: PiSandboxModeRef,
  writeMode: PiSandboxWriteMode,
): Promise<void> {
  const state: PiSandboxSessionState = {
    workspace: resolveWorkspace(workspace),
    modeRef,
    acquired: false,
  };
  sessionStates.set(session, state);
  if (writeMode !== "full_access") {
    await acquirePiSandbox(state);
  }
}

export async function updatePiSandboxSession(
  session: object,
  workspace: string,
  writeMode: PiSandboxWriteMode,
): Promise<void> {
  const state = sessionStates.get(session);
  if (!state) return;
  state.workspace = resolveWorkspace(workspace);
  state.modeRef.value = writeMode;
  if (writeMode !== "full_access" && !state.acquired) {
    await acquirePiSandbox(state);
  }
}

export async function releasePiSandboxSession(session: object): Promise<void> {
  const state = sessionStates.get(session);
  if (!state) return;
  sessionStates.delete(session);
  if (!state.acquired) return;
  state.acquired = false;
  sandboxSessionCount = Math.max(0, sandboxSessionCount - 1);
  if (sandboxSessionCount !== 0) return;
  await waitForSandboxCommands();
  if (sandboxSessionCount !== 0) return;
  const reset = async (): Promise<void> => {
    try {
      await SandboxManager.reset();
    } finally {
      sandboxInitialization = undefined;
      windowsSandboxWorkspace = undefined;
    }
  };
  if (process.platform === "win32") await enqueueWindowsSandbox(reset);
  else await reset();
}

function dynamicTool<T extends { execute: (...args: any[]) => any }>(
  unrestricted: T,
  restricted: T,
  modeRef: PiSandboxModeRef,
  writeCapable = false,
): T {
  return {
    ...restricted,
    execute: (...args: Parameters<T["execute"]>) => {
      if (writeCapable && modeRef.value === "read_only") {
        throw new Error("Pi read-only mode does not allow write-capable tools.");
      }
      return (modeRef.value === "full_access" ? unrestricted : restricted).execute(...args);
    },
  } as T;
}

function createReadOperations(workspace: string): ReadOperations {
  return {
    readFile: async (path) => readFile(await assertPiWorkspacePath(path, workspace)),
    access: async (path) => access(await assertPiWorkspacePath(path, workspace)),
  };
}

function createWriteOperations(workspace: string): WriteOperations {
  return {
    writeFile: async (path, content) => writeFile(await assertPiWorkspacePath(path, workspace, true), content),
    mkdir: async (path) => {
      await mkdir(await assertPiWorkspacePath(path, workspace, true), { recursive: true });
    },
  };
}

function createEditOperations(workspace: string): EditOperations {
  return {
    readFile: async (path) => readFile(await assertPiWorkspacePath(path, workspace)),
    writeFile: async (path, content) => writeFile(await assertPiWorkspacePath(path, workspace, true), content),
    access: async (path) => access(await assertPiWorkspacePath(path, workspace, true)),
  };
}

function createGrepOperations(workspace: string): GrepOperations {
  return {
    isDirectory: async (path) => (await stat(await assertPiWorkspacePath(path, workspace))).isDirectory(),
    readFile: async (path) => (await readFile(await assertPiWorkspacePath(path, workspace))).toString("utf8"),
  };
}

function createFindOperations(workspace: string): FindOperations {
  return {
    exists: async (path) => {
      try {
        await access(await assertPiWorkspacePath(path, workspace));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const searchRoot = await assertPiWorkspacePath(cwd, workspace);
      const matcher = globToRegExp(pattern);
      const results: string[] = [];
      const ignoredDirectories = new Set([".git", "node_modules"]);

      const visit = async (directory: string): Promise<void> => {
        if (results.length >= options.limit) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
          const absolutePath = join(directory, entry.name);
          const relativePath = relative(searchRoot, absolutePath).split("\\").join("/");
          const candidate = pattern.includes("/") ? relativePath : basename(relativePath);
          if (matcher.test(candidate)) results.push(absolutePath);
          if (entry.isDirectory()) await visit(absolutePath);
          if (results.length >= options.limit) return;
        }
      };

      await visit(searchRoot);
      return results;
    },
  };
}

function createLsOperations(workspace: string): LsOperations {
  return {
    exists: async (path) => {
      try {
        await access(await assertPiWorkspacePath(path, workspace));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (path) => stat(await assertPiWorkspacePath(path, workspace)),
    readdir: async (path) => readdir(await assertPiWorkspacePath(path, workspace)),
  };
}

function createSandboxedBashOperations(): BashOperations {
  return {
    exec: (command, cwd, options) => withSandboxCommand(async () => {
      if (process.platform === "win32") {
        return enqueueWindowsSandbox(async () => {
          await ensureWindowsSandbox(cwd);
          return runSandboxedCommand(command, cwd, options);
        });
      }
      await ensureSandboxInitialized();
      return runSandboxedCommand(command, cwd, options);
    }),
  };
}

async function acquirePiSandbox(state: PiSandboxSessionState): Promise<void> {
  if (state.acquired) return;
  state.acquired = true;
  sandboxSessionCount += 1;
  try {
    if (process.platform === "win32") {
      // Windows sandbox-runtime has process-global policy state. Serialize
      // workspace changes with command execution so one session cannot reset
      // another session's policy while its Bash command is running.
      await enqueueWindowsSandbox(() => ensureWindowsSandbox(state.workspace));
    } else {
      await ensureSandboxInitialized();
    }
  } catch (error) {
    state.acquired = false;
    sandboxSessionCount = Math.max(0, sandboxSessionCount - 1);
    throw error;
  }
}

async function ensureSandboxInitialized(): Promise<void> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(`Pi allowed mode requires a sandbox, but ${process.platform} is not supported by sandbox-runtime.`);
  }
  if (!sandboxInitialization) {
    sandboxInitialization = SandboxManager.initialize(createPiSandboxConfig()).catch((error) => {
      sandboxInitialization = undefined;
      throw new Error(`Pi allowed mode could not initialize its sandbox: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await sandboxInitialization;
}

async function ensureWindowsSandbox(workspace: string): Promise<void> {
  const resolvedWorkspace = resolveWorkspace(workspace);
  if (windowsSandboxWorkspace === resolvedWorkspace && sandboxInitialization) {
    await sandboxInitialization;
    return;
  }
  if (sandboxInitialization) {
    try {
      await SandboxManager.reset();
    } finally {
      sandboxInitialization = undefined;
      windowsSandboxWorkspace = undefined;
    }
  }
  sandboxInitialization = SandboxManager.initialize(createPiSandboxConfig(resolvedWorkspace)).catch((error) => {
    sandboxInitialization = undefined;
    windowsSandboxWorkspace = undefined;
    throw new Error(`Pi allowed mode could not initialize its Windows sandbox: ${error instanceof Error ? error.message : String(error)}`);
  });
  await sandboxInitialization;
  windowsSandboxWorkspace = resolvedWorkspace;
}

function enqueueWindowsSandbox<T>(operation: () => Promise<T>): Promise<T> {
  const next = windowsSandboxQueue.then(operation, operation);
  windowsSandboxQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function runSandboxedCommand(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const workspace = resolveWorkspace(cwd);
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: createPiSandboxFilesystem(workspace),
  };
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    process.platform === "win32" ? undefined : customConfig,
    options.signal,
    workspace,
  );
  try {
    return await spawnSandboxedCommand(wrapped.argv, wrapped.env, workspace, options);
  } finally {
    SandboxManager.cleanupAfterCommand();
  }
}

function spawnSandboxedCommand(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("sandbox-runtime returned an empty command");
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...environment, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const detached = process.platform !== "win32";
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const kill = () => terminateProcessTree(child, "SIGKILL", detached);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeout * 1000);
    }
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => {
      finish(() => {
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolveResult({ exitCode });
      });
    });
  });
}

function createPiSandboxFilesystem(workspace: string): FilesystemConfig {
  return {
    denyRead: protectedHomePaths(),
    allowWrite: [workspace],
    denyWrite: [join(workspace, ".env"), join(workspace, ".env.local")],
    allowRead: [],
  };
}

function protectedHomePaths(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
  ];
}

async function assertPiWorkspacePath(
  path: string,
  workspace: string,
  _forWrite = false,
): Promise<string> {
  const resolvedWorkspace = resolveWorkspace(workspace);
  const absolutePath = resolve(path);
  const { boundaryPath, suffix } = await resolveExistingBoundary(absolutePath);
  if (!isPathInsideRoot(boundaryPath, resolvedWorkspace)) {
    assertAllowedPath(boundaryPath, [resolvedWorkspace]);
  }
  const operationPath = suffix ? resolve(boundaryPath, suffix) : boundaryPath;
  if (!isPathInsideRoot(operationPath, resolvedWorkspace)) {
    assertAllowedPath(operationPath, [resolvedWorkspace]);
  }
  return operationPath;
}

async function resolveExistingBoundary(path: string): Promise<{ boundaryPath: string; suffix: string }> {
  let candidate = path;
  for (;;) {
    try {
      return {
        boundaryPath: await realpath(candidate),
        suffix: relative(candidate, path),
      };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return { boundaryPath: candidate, suffix: relative(candidate, path) };
      candidate = parent;
    }
  }
}

async function withSandboxCommand<T>(operation: () => Promise<T>): Promise<T> {
  sandboxCommandCount += 1;
  try {
    return await operation();
  } finally {
    sandboxCommandCount = Math.max(0, sandboxCommandCount - 1);
    if (sandboxCommandCount === 0) {
      for (const resolveWaiter of sandboxCommandWaiters) resolveWaiter();
      sandboxCommandWaiters.clear();
    }
  }
}

function waitForSandboxCommands(): Promise<void> {
  if (sandboxCommandCount === 0) return Promise.resolve();
  return new Promise((resolveWaiter) => sandboxCommandWaiters.add(resolveWaiter));
}

function resolveWorkspace(workspace: string): string {
  const absolute = resolve(workspace);
  if (!existsSync(absolute)) throw new Error(`Pi workspace does not exist: ${workspace}`);
  return realpathSync(absolute);
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
