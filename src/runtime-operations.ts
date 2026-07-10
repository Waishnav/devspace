import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { measuredPayload } from "./tool-metrics.js";
import { resolveExecutable, shellPathInfo } from "./shell-environment.js";

const execFileAsync = promisify(execFile);

export interface RuntimeDiagnosticResult {
  platform: NodeJS.Platform;
  nodeVersion: string;
  workspace: {
    root: string;
    name: string;
    accessible: boolean;
    gitRepository: boolean;
  };
  shellPath: {
    entryCount: number;
    addedEntries: string[];
  };
  executables: Array<{
    command: string;
    found: boolean;
    path?: string;
  }>;
  githubAuthentication: "not_checked" | "authenticated" | "unauthenticated" | "gh_unavailable";
  diagnostics: string[];
  metrics: {
    serverDurationMs: number;
    payloadCharacters: number;
    returnedItems: number;
    truncated: boolean;
  };
}

export async function diagnoseRuntime(input: {
  workspaceRoot: string;
  commands?: string[];
  checkGitHubAuth?: boolean;
}): Promise<RuntimeDiagnosticResult> {
  const startedAt = performance.now();
  const commands = Array.from(new Set(input.commands ?? ["git", "node", "npm", "gh"]))
    .filter((command) => /^[A-Za-z0-9._+-]+$/.test(command))
    .slice(0, 20);
  const shell = shellPathInfo();
  const executables = commands.map((command) => {
    const path = resolveExecutable(command);
    return { command, found: Boolean(path), ...(path ? { path } : {}) };
  });
  const accessible = await pathAccessible(input.workspaceRoot);
  const gitRepository = accessible && await isGitRepository(input.workspaceRoot);
  const ghPath = executables.find((entry) => entry.command === "gh")?.path;
  let githubAuthentication: RuntimeDiagnosticResult["githubAuthentication"] = "not_checked";
  if (input.checkGitHubAuth) {
    if (!ghPath) {
      githubAuthentication = "gh_unavailable";
    } else {
      githubAuthentication = await commandSucceeds(
        ghPath,
        ["auth", "status", "--hostname", "github.com"],
        input.workspaceRoot,
      ) ? "authenticated" : "unauthenticated";
    }
  }

  const diagnostics = [
    accessible ? "Workspace is accessible." : "Workspace is not accessible.",
    gitRepository ? "Git repository detected." : "Git repository not detected.",
    shell.addedEntries.length > 0
      ? `Added ${shell.addedEntries.length} safe PATH fallback(s).`
      : "No PATH fallbacks were needed.",
    ...executables
      .filter((entry) => !entry.found)
      .map((entry) => `Executable not found: ${entry.command}`),
    input.checkGitHubAuth
      ? `GitHub authentication: ${githubAuthentication}.`
      : "GitHub authentication was not checked.",
  ];

  return measuredPayload({
    platform: process.platform,
    nodeVersion: process.version,
    workspace: {
      root: input.workspaceRoot,
      name: basename(input.workspaceRoot),
      accessible,
      gitRepository,
    },
    shellPath: {
      entryCount: shell.entries.length,
      addedEntries: shell.addedEntries,
    },
    executables,
    githubAuthentication,
    diagnostics,
  }, {
    startedAt,
    returnedItems: executables.length + diagnostics.length,
    truncated: false,
  });
}

export interface CompatibilitySmokeResult {
  status: "passed" | "failed";
  steps: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    detail: string;
    durationMs: number;
  }>;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
  };
  metrics: {
    serverDurationMs: number;
    payloadCharacters: number;
    returnedItems: number;
    truncated: boolean;
  };
}

export async function runCompatibilitySmoke(
  workspaceRoot: string,
): Promise<CompatibilitySmokeResult> {
  const startedAt = performance.now();
  const steps: CompatibilitySmokeResult["steps"] = [];

  await smokeStep(steps, "workspace", async () => {
    const info = await stat(workspaceRoot);
    if (!info.isDirectory()) throw new Error("Workspace root is not a directory.");
    return "Workspace directory is accessible.";
  });

  await smokeStep(steps, "list", async () => {
    const entries = await readdir(workspaceRoot);
    return `Listed ${entries.length} root item(s).`;
  });

  const readableCandidate = await firstAccessible([
    join(workspaceRoot, "AGENTS.md"),
    join(workspaceRoot, "package.json"),
    join(workspaceRoot, "README.md"),
  ]);
  if (readableCandidate) {
    await smokeStep(steps, "read", async () => {
      const content = await readFile(readableCandidate, "utf8");
      if (content.length === 0) throw new Error("Selected text file is empty.");
      return `Read ${basename(readableCandidate)} (${content.length} characters).`;
    });
    await smokeStep(steps, "search", async () => {
      const content = await readFile(readableCandidate, "utf8");
      const lines = content.split(/\r?\n/u).filter((line) => /\S/u.test(line));
      if (lines.length === 0) throw new Error("No searchable text was found.");
      return `Found ${lines.length} non-empty line(s).`;
    });
  } else {
    steps.push({
      name: "read",
      status: "skipped",
      detail: "No standard text file was available.",
      durationMs: 0,
    });
    steps.push({
      name: "search",
      status: "skipped",
      detail: "No standard text file was available.",
      durationMs: 0,
    });
  }

  await smokeStep(steps, "shell-path", async () => {
    const executable = resolveExecutable("node");
    if (!executable) throw new Error("Node executable was not resolved from the augmented PATH.");
    const { stdout } = await execFileAsync(executable, ["-e", "process.stdout.write(process.cwd())"], {
      cwd: workspaceRoot,
      timeout: 5_000,
      maxBuffer: 8_192,
    });
    if (!stdout.trim()) throw new Error("Shell probe returned no working directory.");
    return "Resolved and executed Node through the augmented PATH.";
  });

  const gitPath = resolveExecutable("git");
  if (gitPath && await isGitRepository(workspaceRoot)) {
    await smokeStep(steps, "git", async () => {
      await execFileAsync(gitPath, ["status", "--short", "--branch"], {
        cwd: workspaceRoot,
        timeout: 5_000,
        maxBuffer: 64_000,
      });
      return "Git status completed.";
    });
  } else {
    steps.push({
      name: "git",
      status: "skipped",
      detail: gitPath ? "Workspace is not a Git repository." : "Git executable was not found.",
      durationMs: 0,
    });
  }

  const appResource = join(workspaceRoot, "src", "ui", "workspace-app.html");
  steps.push({
    name: "app-resource",
    status: await pathAccessible(appResource) ? "passed" : "skipped",
    detail: await pathAccessible(appResource)
      ? "MCP App resource entry point is present."
      : "No MCP App resource entry point was detected in this workspace.",
    durationMs: 0,
  });

  const summary = {
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
  };

  return measuredPayload({
    status: summary.failed === 0 ? "passed" : "failed",
    steps,
    summary,
  }, {
    startedAt,
    returnedItems: steps.length,
    truncated: false,
  });
}

export function finderOpenArguments(
  path: string,
  kind: "file" | "directory",
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform !== "darwin") return undefined;
  return kind === "directory" ? [path] : ["-R", path];
}

export async function openPathInFinder(path: string): Promise<{
  status: "opened" | "unsupported";
  path: string;
  kind: "file" | "directory";
}> {
  const info = await stat(path);
  const kind = info.isDirectory() ? "directory" : "file";
  const args = finderOpenArguments(path, kind);
  if (!args) {
    return { status: "unsupported", path, kind };
  }
  const openExecutable = resolveExecutable("open") ?? "/usr/bin/open";
  await execFileAsync(openExecutable, args, {
    timeout: 10_000,
    maxBuffer: 8_192,
  });
  return { status: "opened", path, kind };
}

async function smokeStep(
  steps: CompatibilitySmokeResult["steps"],
  name: string,
  operation: () => Promise<string>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    const detail = await operation();
    steps.push({
      name,
      status: "passed",
      detail,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  } catch (error) {
    steps.push({
      name,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  }
}

async function pathAccessible(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstAccessible(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathAccessible(path)) return path;
  }
  return undefined;
}

async function isGitRepository(cwd: string): Promise<boolean> {
  const gitPath = resolveExecutable("git");
  if (!gitPath) return false;
  return commandSucceeds(gitPath, ["rev-parse", "--is-inside-work-tree"], cwd);
}

async function commandSucceeds(command: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync(command, args, {
      cwd,
      timeout: 5_000,
      maxBuffer: 8_192,
    });
    return true;
  } catch {
    return false;
  }
}
