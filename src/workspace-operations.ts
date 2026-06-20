import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveAllowedPath } from "./roots.js";

const execFileAsync = promisify(execFile);

export interface ApplyWorkspacePatchInput {
  patch: string;
}

export interface ApplyWorkspacePatchResult {
  stdout: string;
  stderr: string;
  files: string[];
}

export interface GitPushInput {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export interface GitPushResult {
  stdout: string;
  stderr: string;
  remote: string;
  branch?: string;
}

export async function applyWorkspacePatch(
  input: ApplyWorkspacePatchInput,
  context: { root: string },
): Promise<ApplyWorkspacePatchResult> {
  const files = extractPatchPaths(input.patch);
  if (files.length === 0) {
    throw new Error("Patch does not contain any file paths.");
  }

  for (const file of files) {
    resolveAllowedPath(file, context.root, [context.root]);
  }

  const { stdout, stderr } = await spawnWithInput(
    "git",
    ["apply", "--whitespace=nowarn", "-"],
    {
      cwd: context.root,
      maxBuffer: 10 * 1024 * 1024,
    },
    input.patch,
  );

  return { stdout, stderr, files };
}

export async function gitPush(
  input: GitPushInput,
  context: { root: string },
): Promise<GitPushResult> {
  const remote = input.remote ?? "origin";
  assertGitRefPart(remote, "remote");
  if (input.branch !== undefined) assertGitRefPart(input.branch, "branch");

  const args = ["push"];
  if (input.setUpstream) args.push("-u");
  args.push(remote);
  if (input.branch) args.push(input.branch);

  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: context.root,
    maxBuffer: 10 * 1024 * 1024,
  });

  return { stdout, stderr, remote, branch: input.branch };
}

export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();

  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;

    const oldPath = normalizePatchPath(match[1]);
    const newPath = normalizePatchPath(match[2]);
    if (oldPath) paths.add(oldPath);
    if (newPath) paths.add(newPath);
  }

  return Array.from(paths);
}

function normalizePatchPath(path: string | undefined): string | undefined {
  if (!path || path === "/dev/null") return undefined;
  return path;
}

function assertGitRefPart(value: string, name: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`Invalid git ${name}.`);
  }
}

function spawnWithInput(
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer: number },
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > options.maxBuffer) {
        child.kill();
        reject(new Error("Command output exceeded maxBuffer."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > options.maxBuffer) {
        child.kill();
        reject(new Error("Command output exceeded maxBuffer."));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
      }
    });

    child.stdin.end(input);
  });
}
