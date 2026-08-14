import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OPENAI_TEAM_ID = "2DC432GLL2";
const DEFAULT_CHATGPT_APP = "/Applications/ChatGPT.app";

export class CodexRuntimeDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexRuntimeDiscoveryError";
  }
}

export interface CodexRuntimePaths {
  appPath: string;
  appVersion: string;
  codexHome: string;
  codexExecutable: string;
  nodeExecutable: string;
  nodeReplExecutable: string;
  nodeModulesDir: string;
  computerUseAppPath: string;
  computerUseClientExecutable: string;
  browserClientPath: string;
  browserClientSha256: string;
  browserPluginVersion: string;
  openAiTeamId: string;
}

export interface DiscoverCodexRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  verifySignatures?: boolean;
  candidateAppPaths?: string[];
}

interface SignedExecutableExpectation {
  identifiers: string[];
  label: string;
}

export function isCodexRuntimeSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin";
}

export async function discoverCodexRuntime(
  options: DiscoverCodexRuntimeOptions = {},
): Promise<CodexRuntimePaths> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (!isCodexRuntimeSupportedPlatform(platform)) {
    throw new CodexRuntimeDiscoveryError(
      `Codex local Computer Use is unsupported on ${platform}.`,
      "codex_runtime_unsupported_platform",
    );
  }

  const appPath = await discoverChatGptApp({
    env,
    homeDirectory,
    candidates: options.candidateAppPaths,
  });
  const resourcesDir = join(appPath, "Contents", "Resources");
  const codexExecutable = join(resourcesDir, "codex");
  const nodeExecutable = join(resourcesDir, "cua_node", "bin", "node");
  const nodeReplExecutable = join(resourcesDir, "cua_node", "bin", "node_repl");
  const nodeModulesDir = join(resourcesDir, "cua_node", "lib", "node_modules");
  const codexHome = resolve(env.CODEX_HOME ?? join(homeDirectory, ".codex"));

  await assertExecutable(codexExecutable, "Codex app-server executable");
  await assertExecutable(nodeExecutable, "Codex Node executable");
  await assertExecutable(nodeReplExecutable, "Codex node_repl executable");

  const computerUseAppPath = await discoverComputerUseApp({ codexHome, nodeModulesDir });
  const computerUseClientExecutable = join(
    computerUseAppPath,
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
    "Contents",
    "MacOS",
    "SkyComputerUseClient",
  );
  await assertExecutable(computerUseClientExecutable, "Codex Computer Use MCP client");

  const browserPlugin = await discoverBrowserPlugin(codexHome);
  const appVersion = await readPlistString(
    join(appPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  );

  const verifySignatures = options.verifySignatures
    ?? env.DEVSPACE_CODEX_SKIP_SIGNATURE_CHECK !== "1";
  if (verifySignatures) {
    await assertSignedExecutable(codexExecutable, {
      identifiers: ["codex"],
      label: "Codex app-server executable",
    });
    await assertSignedExecutable(nodeReplExecutable, {
      identifiers: ["node_repl"],
      label: "Codex node_repl executable",
    });
    await assertSignedExecutable(computerUseClientExecutable, {
      identifiers: ["com.openai.sky.CUAService.cli"],
      label: "Codex Computer Use MCP client",
    });
  }

  return {
    appPath,
    appVersion,
    codexHome,
    codexExecutable: await realpath(codexExecutable),
    nodeExecutable: await realpath(nodeExecutable),
    nodeReplExecutable: await realpath(nodeReplExecutable),
    nodeModulesDir: await realpath(nodeModulesDir),
    computerUseAppPath,
    computerUseClientExecutable: await realpath(computerUseClientExecutable),
    browserClientPath: browserPlugin.path,
    browserClientSha256: await sha256File(browserPlugin.path),
    browserPluginVersion: browserPlugin.version,
    openAiTeamId: OPENAI_TEAM_ID,
  };
}

async function discoverChatGptApp(input: {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  candidates?: string[];
}): Promise<string> {
  const candidates = input.candidates ?? [
    input.env.DEVSPACE_CODEX_APP_PATH,
    DEFAULT_CHATGPT_APP,
    join(input.homeDirectory, "Applications", "ChatGPT.app"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const resolved = await realpath(resolve(candidate));
      await access(join(resolved, "Contents", "Resources", "codex"), constants.X_OK);
      return resolved;
    } catch {
      // Try the next candidate.
    }
  }

  throw new CodexRuntimeDiscoveryError(
    `Unable to locate a ChatGPT application containing the Codex runtime. Checked: ${candidates.join(", ")}`,
    "codex_app_not_found",
  );
}

async function discoverComputerUseApp(input: {
  codexHome: string;
  nodeModulesDir: string;
}): Promise<string> {
  const candidates = [
    join(input.codexHome, "computer-use", "Codex Computer Use.app"),
    join(input.nodeModulesDir, "@oai", "sky", "Codex Computer Use.app"),
  ];

  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (metadata.isDirectory()) return resolved;
    } catch {
      // Try the next candidate.
    }
  }

  throw new CodexRuntimeDiscoveryError(
    "Unable to locate Codex Computer Use.app. Open ChatGPT Computer Use once so the signed runtime is installed.",
    "codex_computer_use_app_not_found",
  );
}

async function discoverBrowserPlugin(
  codexHome: string,
): Promise<{ path: string; version: string }> {
  const pluginRoot = join(codexHome, "plugins", "cache", "openai-bundled", "chrome");
  let entries;
  try {
    entries = await readdir(pluginRoot, { withFileTypes: true });
  } catch (error) {
    throw new CodexRuntimeDiscoveryError(
      `Unable to read the Codex Chrome plugin directory: ${pluginRoot}`,
      "codex_chrome_plugin_not_found",
      { cause: error },
    );
  }

  const candidates: Array<{
    path: string;
    version: string;
    mtimeMs: number;
  }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = join(pluginRoot, entry.name, "scripts", "browser-client.mjs");
    try {
      const resolved = await realpath(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      await assertContainedPath(pluginRoot, resolved, "Chrome browser client");
      const metadata = await stat(resolved);
      if (!metadata.isFile()) continue;
      assertOwnerOnlyWritable(metadata.mode, resolved);
      candidates.push({
        path: resolved,
        version: entry.name === "latest" ? basename(resolve(resolved, "..", "..")) : entry.name,
        mtimeMs: metadata.mtimeMs,
      });
    } catch {
      // Ignore incomplete plugin versions.
    }
  }

  candidates.sort((left, right) => {
    const versionComparison = compareVersionStrings(right.version, left.version);
    return versionComparison !== 0 ? versionComparison : right.mtimeMs - left.mtimeMs;
  });
  const selected = candidates[0];
  if (!selected) {
    throw new CodexRuntimeDiscoveryError(
      `Unable to locate scripts/browser-client.mjs under ${pluginRoot}.`,
      "codex_chrome_browser_client_not_found",
    );
  }
  return { path: selected.path, version: selected.version };
}

async function assertExecutable(path: string, label: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a regular file");
    await access(path, constants.X_OK);
  } catch (error) {
    throw new CodexRuntimeDiscoveryError(
      `${label} is missing or not executable: ${path}`,
      "codex_runtime_executable_missing",
      { cause: error },
    );
  }
}

async function assertSignedExecutable(
  path: string,
  expectation: SignedExecutableExpectation,
): Promise<void> {
  let output: string;
  try {
    const result = await execFile("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    throw new CodexRuntimeDiscoveryError(
      `${expectation.label} failed code-signature inspection: ${path}`,
      "codex_runtime_signature_invalid",
      { cause: error },
    );
  }

  const teamId = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  if (teamId !== OPENAI_TEAM_ID || !identifier || !expectation.identifiers.includes(identifier)) {
    throw new CodexRuntimeDiscoveryError(
      `${expectation.label} has an unexpected signature identity: identifier=${identifier ?? "missing"}, team=${teamId ?? "missing"}`,
      "codex_runtime_signature_identity_mismatch",
    );
  }
}

async function assertContainedPath(root: string, candidate: string, label: string): Promise<void> {
  const resolvedRoot = await realpath(root);
  const resolvedCandidate = await realpath(candidate);
  const prefix = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) {
    throw new CodexRuntimeDiscoveryError(
      `${label} escaped its trusted root: ${resolvedCandidate}`,
      "codex_runtime_path_escape",
    );
  }
}

function assertOwnerOnlyWritable(mode: number, path: string): void {
  if ((mode & 0o022) !== 0) {
    throw new CodexRuntimeDiscoveryError(
      `Trusted Codex runtime file is group- or world-writable: ${path}`,
      "codex_runtime_insecure_permissions",
    );
  }
}

async function readPlistString(path: string, key: string): Promise<string> {
  try {
    const result = await execFile(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", path],
      { encoding: "utf8", timeout: 5_000 },
    );
    const value = result.stdout.trim();
    if (value) return value;
  } catch {
    // Fall through to an explicit error.
  }
  throw new CodexRuntimeDiscoveryError(
    `Unable to read ${key} from ${path}.`,
    "codex_runtime_plist_invalid",
  );
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/u).filter(Boolean).map(Number);
  const rightParts = right.split(/[^0-9]+/u).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}
