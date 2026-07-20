/**
 * Advanced tools for DevSpace MCP server.
 *
 * This module provides read_many, search_text, task guardrails, job management,
 * and Git workflow tools. It is compiled by tsc into dist/advanced-tools.js.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceRegistry, WorkspaceReadPath, Workspace } from "./workspaces.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";

const execFileAsync = promisify(execFile);
const MAX_READ_FILES = 50;
const DEFAULT_READ_BUDGET = 120_000;
const MAX_READ_BUDGET = 500_000;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 500;

// ─── Public Types ──────────────────────────────────────────────────────

export interface AdvancedGuardStore {
  apply(workspaceId: string, root: string, input?: unknown): {
    protectedPaths: string[];
    blockedCommandPatterns: string[];
  };
  assertPathAllowed(workspaceId: string, path: string): void;
  assertCommandAllowed(workspaceId: string, command: string): void;
  assertReadAllowed?(workspaceId: string, path: string): void;
  summary(workspaceId: string): { protectedPaths: string[]; blockedCommandPatterns: string[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RegisterAppToolFn = (server: any, name: string, descriptor: any, handler: any) => void;

export interface AdvancedToolsDependencies {
  z: typeof import("zod/v4");
  registerAppTool: RegisterAppToolFn;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  guards: AdvancedGuardStore;
}

// ─── Internal Types ────────────────────────────────────────────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: unknown;
}

interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

interface ProtectedPathEntry {
  input: string;
  absolutePath: string;
  normalized: string;
}

interface BlockedPatternEntry {
  input: string;
  regex: RegExp;
}

interface GuardEntry {
  root: string;
  protectedPaths: ProtectedPathEntry[];
  blockedCommandPatterns: BlockedPatternEntry[];
}

interface GitState {
  status: string;
  head: string;
  origin: string;
  remote: string;
  remoteName: string;
  branch: string;
  clean: boolean;
  aligned: boolean;
}

interface TextResult {
  text: string;
  truncated: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────

export const ADVANCED_TOOL_NAMES = [
  "read_many",
  "search_text",
  "apply_task_guardrails",
  "start_job",
  "job_status",
  "job_cancel",
  "git_preflight",
  "git_stage_exact",
  "git_commit",
  "git_push",
  "git_postflight",
];

function textResult(text: string, structuredContent: Record<string, unknown> = {}): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function normalizedPath(path: string): string {
  const normalized = resolve(path).replaceAll("/", sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === "" || (!relationship.startsWith("..") && relationship !== ".." && !resolve(relationship).startsWith(`..${sep}`));
}

function assertInsideRoot(path: string, root: string, label: string): string {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  const relationship = relative(absoluteRoot, absolutePath);
  if (relationship === ".." || relationship.startsWith(`..${sep}`) || resolve(relationship).startsWith(`..${sep}`)) {
    throw new Error(`${label} is outside the workspace root.`);
  }
  return absolutePath;
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid blocked command pattern: ${pattern}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Guard Store ───────────────────────────────────────────────────────

export function createAdvancedGuardStore(): AdvancedGuardStore {
  const entries = new Map<string, GuardEntry>();
  return {
    apply(workspaceId: string, root: string, input: unknown = {}) {
      const inputObj = input as { protectedPaths?: string[]; blockedCommandPatterns?: string[] };
      const absoluteRoot = resolve(root);
      const protectedPaths = [...new Set(inputObj.protectedPaths ?? [])].map((path) => {
        const absolutePath = assertInsideRoot(resolve(absoluteRoot, path), absoluteRoot, `Protected path ${path}`);
        return {
          input: path,
          absolutePath,
          normalized: normalizedPath(absolutePath),
        };
      });
      const blockedCommandPatterns = [...new Set(inputObj.blockedCommandPatterns ?? [])].map((pattern) => ({
        input: pattern,
        regex: compilePattern(pattern),
      }));
      const entry: GuardEntry = { root: absoluteRoot, protectedPaths, blockedCommandPatterns };
      entries.set(workspaceId, entry);
      return {
        protectedPaths: protectedPaths.map((item) => item.input),
        blockedCommandPatterns: blockedCommandPatterns.map((item) => item.input),
      };
    },
    assertPathAllowed(workspaceId: string, path: string) {
      const entry = entries.get(workspaceId);
      if (!entry) return;
      const candidate = normalizedPath(assertInsideRoot(path, entry.root, "Path"));
      const blocked = entry.protectedPaths.find((item) => {
        return candidate === item.normalized || candidate.startsWith(`${item.normalized}${sep}`);
      });
      if (blocked) {
        throw new Error(`Path is protected by active task guardrails: ${blocked.input}`);
      }
    },
    assertCommandAllowed(workspaceId: string, command: string) {
      const entry = entries.get(workspaceId);
      if (!entry) return;
      const blocked = entry.blockedCommandPatterns.find((item) => item.regex.test(command));
      if (blocked) {
        throw new Error(`Command is blocked by active task guardrails: ${blocked.input}`);
      }
    },
    summary(workspaceId: string) {
      const entry = entries.get(workspaceId);
      return {
        protectedPaths: entry?.protectedPaths.map((item) => item.input) ?? [],
        blockedCommandPatterns: entry?.blockedCommandPatterns.map((item) => item.input) ?? [],
      };
    },
  };
}

export function validateExactStagePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("git_stage_exact requires one or more exact file paths.");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const path = String(rawPath ?? "").trim();
    const normalized = path.replaceAll("\\", "/");
    if (
      !path ||
      path.startsWith("-") ||
      normalized === "." ||
      normalized === "./" ||
      normalized === "*" ||
      /[*?\[\]]/.test(path)
    ) {
      throw new Error(`Only exact file paths are allowed for staging: ${rawPath}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(path);
    }
  }
  return result;
}

function sliceLines(text: string, offset: number = 1, limit?: number): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = Math.max(0, offset - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

function truncateText(text: string, maxCharacters: number): TextResult {
  if (text.length <= maxCharacters) return { text, truncated: false };
  if (maxCharacters <= 0) return { text: "", truncated: true };
  const marker = "\n... content truncated ...\n";
  if (maxCharacters <= marker.length) {
    return { text: text.slice(0, maxCharacters), truncated: true };
  }
  const available = maxCharacters - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    text: text.slice(0, head) + marker + text.slice(text.length - tail),
    truncated: true,
  };
}

// ─── Executable / Git Helpers ──────────────────────────────────────────

async function runExecutable(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message ?? String(error),
      error,
    };
  }
}

function assertExecutableSuccess(result: ExecResult, label: string): ExecResult {
  if (result.exitCode === 0) return result;
  const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`${label} failed with exit code ${result.exitCode}${details ? `:\n${details}` : "."}`);
}

async function runGit(root: string, args: string[], label: string = `git ${args.join(" ")}`): Promise<ExecResult> {
  return assertExecutableSuccess(await runExecutable("git", args, { cwd: root, timeoutMs: 120_000 }), label);
}

function parseRemoteSha(output: string): string {
  const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.split(/\s+/, 1)[0] ?? "";
}

async function collectGitState(root: string, remote: string, branch: string): Promise<GitState> {
  const ref = `refs/heads/${branch}`;
  const [status, head, origin, remoteHead] = await Promise.all([
    runGit(root, ["status", "--short"], "git status"),
    runGit(root, ["rev-parse", "HEAD"], "git rev-parse HEAD"),
    runGit(root, ["rev-parse", `${remote}/${branch}`], `git rev-parse ${remote}/${branch}`),
    runGit(root, ["ls-remote", remote, ref], `git ls-remote ${remote} ${ref}`),
  ]);
  const values = {
    status: status.stdout.trimEnd(),
    head: head.stdout.trim(),
    origin: origin.stdout.trim(),
    remote: parseRemoteSha(remoteHead.stdout),
    remoteName: remote,
    branch,
  };
  return {
    ...values,
    clean: values.status.length === 0,
    aligned: Boolean(values.head && values.head === values.origin && values.head === values.remote),
  };
}

function safeGitToken(value: unknown, label: string): string {
  const token = String(value ?? "").trim();
  if (!token || token.startsWith("-") || !/^[A-Za-z0-9._\/-]+$/.test(token)) {
    throw new Error(`Invalid Git ${label}: ${value}`);
  }
  return token;
}

function jobStructured(snapshot: ProcessSnapshot) {
  return {
    sessionId: snapshot.sessionId,
    running: snapshot.running,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    output: snapshot.output ?? "",
    outputTruncated: Boolean(snapshot.outputTruncated),
    wallTimeMs: snapshot.wallTimeMs ?? 0,
  };
}

// ─── Tool Registration ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAdvancedTools(server: any, dependencies: AdvancedToolsDependencies): void {
  const { z, registerAppTool, workspaces, processSessions, guards } = dependencies;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerTool = (serverInstance: any, name: string, descriptor: any, handler: any) =>
    registerAppTool(serverInstance, name, { _meta: {}, ...descriptor }, handler);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const writeAction = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const shellAction = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

  registerTool(server, "read_many", {
    title: "Read many files",
    description: "Read multiple workspace files in one call. Use this instead of repeated read calls when a task lists several known files. Each file supports optional 1-indexed offset and line limit.",
    inputSchema: {
      workspaceId: z.string(),
      files: z.array(z.object({
        path: z.string(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      })).min(1).max(MAX_READ_FILES),
      maxTotalCharacters: z.number().int().positive().max(MAX_READ_BUDGET).optional(),
    },
    outputSchema: {
      result: z.string(),
      files: z.array(z.object({
        path: z.string(),
        content: z.string().optional(),
        error: z.string().optional(),
        truncated: z.boolean(),
      })),
      totalCharacters: z.number(),
      truncated: z.boolean(),
    },
    annotations: readOnly,
  }, async ({ workspaceId, files, maxTotalCharacters }: {
    workspaceId: string;
    files: { path: string; offset?: number; limit?: number }[];
    maxTotalCharacters?: number;
  }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const budget = maxTotalCharacters ?? DEFAULT_READ_BUDGET;
    let remaining = budget;
    let anyTruncated = false;
    const loaded = await Promise.all(files.map(async (file) => {
      try {
        const readPath = workspaces.resolveReadPath(workspace, file.path) as WorkspaceReadPath;
        const raw = await readFile(readPath.absolutePath, "utf8");
        workspaces.markReadPathLoaded(workspace, readPath);
        return {
          path: file.path,
          selected: sliceLines(raw, file.offset ?? 1, file.limit),
        };
      } catch (error) {
        return { path: file.path, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const outputs = loaded.map((file) => {
      if ("error" in file && file.error) return { path: file.path, error: file.error, truncated: false };
      const selected = (file as { path: string; selected: string }).selected;
      const clipped = truncateText(selected, Math.max(0, remaining));
      remaining = Math.max(0, remaining - clipped.text.length);
      anyTruncated ||= clipped.truncated;
      return { path: file.path, content: clipped.text, truncated: clipped.truncated };
    });
    const totalCharacters = outputs.reduce((sum, file) => sum + (file.content?.length ?? 0), 0);
    const result = `Read ${outputs.filter((file) => !file.error).length}/${outputs.length} files (${totalCharacters} characters).`;
    return textResult(result, { result, files: outputs, totalCharacters, truncated: anyTruncated });
  });

  registerTool(server, "search_text", {
    title: "Search text",
    description: "Search file contents with ripgrep without a shell round trip. Defaults to fixed-string smart-case matching and returns a bounded number of line matches.",
    inputSchema: {
      workspaceId: z.string(),
      query: z.string().min(1),
      paths: z.array(z.string()).max(20).optional(),
      glob: z.string().optional(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
    },
    outputSchema: {
      result: z.string(),
      matches: z.array(z.string()),
      matchCount: z.number(),
      truncated: z.boolean(),
    },
    annotations: readOnly,
  }, async ({ workspaceId, query, paths, glob, regex, caseSensitive, maxResults }: {
    workspaceId: string;
    query: string;
    paths?: string[];
    glob?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
  }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const targets = paths?.length ? paths : ["."];
    for (const path of targets) workspaces.resolvePath(workspace, path);
    const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
    if (!regex) args.push("--fixed-strings");
    args.push(caseSensitive ? "--case-sensitive" : "--smart-case");
    if (glob) args.push("--glob", glob);
    args.push("--", query, ...targets);
    const search = await runExecutable("rg", args, { cwd: workspace.root, timeoutMs: 60_000 });
    if (![0, 1].includes(search.exitCode)) assertExecutableSuccess(search, "ripgrep search");
    const allMatches = search.stdout.replaceAll("\r\n", "\n").split("\n").filter(Boolean);
    const limit = maxResults ?? DEFAULT_SEARCH_RESULTS;
    const matches = allMatches.slice(0, limit);
    const truncated = allMatches.length > matches.length;
    const result = `Found ${allMatches.length} match(es)${truncated ? `; returned the first ${matches.length}` : ""}.`;
    return textResult(result, { result, matches, matchCount: allMatches.length, truncated });
  });

  registerTool(server, "apply_task_guardrails", {
    title: "Apply task guardrails",
    description: "Set workspace-scoped protected paths and blocked command regular expressions for the current task. Active guardrails are enforced by edit, write, bash, start_job, and git_stage_exact. Call again to replace the current guardrails; pass empty arrays to clear them.",
    inputSchema: {
      workspaceId: z.string(),
      protectedPaths: z.array(z.string()).max(100).optional(),
      blockedCommandPatterns: z.array(z.string()).max(100).optional(),
    },
    outputSchema: {
      result: z.string(),
      protectedPaths: z.array(z.string()),
      blockedCommandPatterns: z.array(z.string()),
      protectedPathCount: z.number(),
      blockedCommandPatternCount: z.number(),
    },
    annotations: writeAction,
  }, async ({ workspaceId, protectedPaths, blockedCommandPatterns }: {
    workspaceId: string;
    protectedPaths?: string[];
    blockedCommandPatterns?: string[];
  }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const applied = guards.apply(workspaceId, workspace.root, { protectedPaths, blockedCommandPatterns });
    const structuredContent = {
      result: `Applied ${applied.protectedPaths.length} protected path(s) and ${applied.blockedCommandPatterns.length} blocked command pattern(s).`,
      protectedPaths: applied.protectedPaths,
      blockedCommandPatterns: applied.blockedCommandPatterns,
      protectedPathCount: applied.protectedPaths.length,
      blockedCommandPatternCount: applied.blockedCommandPatterns.length,
    };
    return textResult(structuredContent.result, structuredContent);
  });

  registerTool(server, "start_job", {
    title: "Start long job",
    description: "Start a long-running test, build, doctor, or inspection command without waiting for the full process. Returns a sessionId when the process is still running; poll it with job_status.",
    inputSchema: {
      workspaceId: z.string(),
      command: z.string().min(1),
      workingDirectory: z.string().optional(),
      yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
      maxOutputTokens: z.number().int().positive().max(100_000).optional(),
    },
    outputSchema: {
      result: z.string(),
      sessionId: z.number().optional(),
      running: z.boolean(),
      exitCode: z.number().optional(),
      signal: z.string().optional(),
      output: z.string(),
      outputTruncated: z.boolean(),
      wallTimeMs: z.number(),
    },
    annotations: shellAction,
  }, async ({ workspaceId, command, workingDirectory, yieldTimeMs, maxOutputTokens }: {
    workspaceId: string;
    command: string;
    workingDirectory?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    guards.assertCommandAllowed(workspaceId, command);
    const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
    const snapshot = await processSessions.start({
      workspaceId,
      workspaceRoot: workspace.root,
      cwd,
      command,
      tty: false,
      yieldTimeMs: yieldTimeMs ?? 0,
      maxOutputTokens: maxOutputTokens ?? 2_000,
    });
    const job = jobStructured(snapshot);
    const result = job.running ? `Job started with sessionId ${job.sessionId}.` : `Job completed with exit code ${job.exitCode}.`;
    return textResult([result, job.output].filter(Boolean).join("\n"), { result, ...job });
  });

  registerTool(server, "job_status", {
    title: "Poll job",
    description: "Poll a process started by start_job. Output is incremental and consumed on each poll. The final response includes the real exit code.",
    inputSchema: {
      workspaceId: z.string(),
      sessionId: z.number().int().positive(),
      waitMs: z.number().int().min(0).max(110_000).optional(),
      maxOutputTokens: z.number().int().positive().max(100_000).optional(),
    },
    outputSchema: {
      result: z.string(),
      sessionId: z.number().optional(),
      running: z.boolean(),
      exitCode: z.number().optional(),
      signal: z.string().optional(),
      output: z.string(),
      outputTruncated: z.boolean(),
      wallTimeMs: z.number(),
    },
    annotations: readOnly,
  }, async ({ workspaceId, sessionId, waitMs, maxOutputTokens }: {
    workspaceId: string;
    sessionId: number;
    waitMs?: number;
    maxOutputTokens?: number;
  }) => {
    workspaces.getWorkspace(workspaceId);
    const snapshot = await processSessions.write({
      workspaceId,
      sessionId,
      chars: "",
      yieldTimeMs: waitMs ?? 5_000,
      maxOutputTokens: maxOutputTokens ?? 2_000,
    });
    const job = jobStructured(snapshot);
    const result = job.running ? `Job ${sessionId} is still running.` : `Job ${sessionId} completed with exit code ${job.exitCode}.`;
    return textResult([result, job.output].filter(Boolean).join("\n"), { result, ...job });
  });

  registerTool(server, "job_cancel", {
    title: "Cancel job",
    description: "Terminate a process started by start_job and return its final available output.",
    inputSchema: {
      workspaceId: z.string(),
      sessionId: z.number().int().positive(),
    },
    outputSchema: {
      result: z.string(),
      sessionId: z.number().optional(),
      running: z.boolean(),
      exitCode: z.number().optional(),
      signal: z.string().optional(),
      output: z.string(),
      outputTruncated: z.boolean(),
      wallTimeMs: z.number(),
    },
    annotations: shellAction,
  }, async ({ workspaceId, sessionId }: { workspaceId: string; sessionId: number }) => {
    workspaces.getWorkspace(workspaceId);
    processSessions.terminate(workspaceId, sessionId);
    const snapshot = await processSessions.write({
      workspaceId,
      sessionId,
      chars: "",
      yieldTimeMs: 1_000,
      maxOutputTokens: 2_000,
    });
    const job = jobStructured(snapshot);
    const result = job.running ? `Cancellation requested for job ${sessionId}.` : `Job ${sessionId} stopped.`;
    return textResult([result, job.output].filter(Boolean).join("\n"), { result, ...job });
  });

  const gitStateSchema = {
    result: z.string(),
    status: z.string(),
    head: z.string(),
    origin: z.string(),
    remote: z.string(),
    remoteName: z.string(),
    branch: z.string(),
    clean: z.boolean(),
    aligned: z.boolean(),
  };

  const registerGitStateTool = (name: string, title: string, description: string) => {
    registerTool(server, name, {
      title,
      description,
      inputSchema: {
        workspaceId: z.string(),
        remote: z.string().optional(),
        branch: z.string().optional(),
      },
      outputSchema: gitStateSchema,
      annotations: readOnly,
    }, async ({ workspaceId, remote, branch }: {
      workspaceId: string;
      remote?: string;
      branch?: string;
    }) => {
      const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
      const remoteName = safeGitToken(remote ?? "origin", "remote");
      const branchName = safeGitToken(branch ?? "master", "branch");
      const state = await collectGitState(workspace.root, remoteName, branchName);
      const result = state.aligned
        ? `HEAD, ${remoteName}/${branchName}, and remote ${branchName} are aligned at ${state.head}.`
        : `Git refs are not aligned. HEAD=${state.head}, ${remoteName}/${branchName}=${state.origin}, remote=${state.remote || "missing"}.`;
      return textResult([result, state.status ? `Status:\n${state.status}` : "Working tree is clean."].join("\n"), { result, ...state });
    });
  };

  registerGitStateTool(
    "git_preflight",
    "Git preflight",
    "Run git status, rev-parse HEAD, rev-parse remote tracking branch, and ls-remote concurrently. Use before modifying a protected branch workflow.",
  );

  registerTool(server, "git_stage_exact", {
    title: "Stage exact files",
    description: "Stage only the explicit file paths supplied. Wildcards, '.', -A, --all, protected paths, and paths outside the workspace are rejected.",
    inputSchema: {
      workspaceId: z.string(),
      paths: z.array(z.string()).min(1).max(200),
    },
    outputSchema: {
      result: z.string(),
      stagedPaths: z.array(z.string()),
    },
    annotations: writeAction,
  }, async ({ workspaceId, paths }: { workspaceId: string; paths: string[] }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const exactPaths = validateExactStagePaths(paths);
    for (const path of exactPaths) {
      const absolutePath = workspaces.resolvePath(workspace, path);
      guards.assertPathAllowed(workspaceId, absolutePath);
    }
    await runGit(workspace.root, ["add", "--", ...exactPaths], "git add exact paths");
    const staged = await runGit(workspace.root, ["diff", "--cached", "--name-only"], "git diff --cached --name-only");
    const stagedPaths = staged.stdout.replaceAll("\r\n", "\n").split("\n").filter(Boolean);
    const result = `Staged ${stagedPaths.length} file(s): ${stagedPaths.join(", ") || "none"}.`;
    return textResult(result, { result, stagedPaths });
  });

  registerTool(server, "git_commit", {
    title: "Create Git commit",
    description: "Commit the currently staged files with one explicit message. This does not stage additional files.",
    inputSchema: {
      workspaceId: z.string(),
      message: z.string().min(1).max(500),
    },
    outputSchema: {
      result: z.string(),
      commit: z.string(),
      output: z.string(),
    },
    annotations: writeAction,
  }, async ({ workspaceId, message }: { workspaceId: string; message: string }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const commit = await runGit(workspace.root, ["commit", "-m", message], "git commit");
    const sha = (await runGit(workspace.root, ["rev-parse", "HEAD"], "git rev-parse HEAD")).stdout.trim();
    const output = [commit.stdout, commit.stderr].filter(Boolean).join("\n").trim();
    const result = `Created commit ${sha}.`;
    return textResult([result, output].filter(Boolean).join("\n"), { result, commit: sha, output });
  });

  registerTool(server, "git_push", {
    title: "Push Git branch",
    description: "Run a normal non-force git push for one explicit remote and branch. Force options are not available.",
    inputSchema: {
      workspaceId: z.string(),
      remote: z.string().optional(),
      branch: z.string().optional(),
    },
    outputSchema: {
      result: z.string(),
      output: z.string(),
    },
    annotations: shellAction,
  }, async ({ workspaceId, remote, branch }: {
    workspaceId: string;
    remote?: string;
    branch?: string;
  }) => {
    const workspace = workspaces.getWorkspace(workspaceId) as Workspace;
    const remoteName = safeGitToken(remote ?? "origin", "remote");
    const branchName = safeGitToken(branch ?? "master", "branch");
    const pushed = await runGit(workspace.root, ["push", remoteName, branchName], "git push");
    const output = [pushed.stdout, pushed.stderr].filter(Boolean).join("\n").trim();
    const result = `Pushed ${branchName} to ${remoteName} without force.`;
    return textResult([result, output].filter(Boolean).join("\n"), { result, output });
  });

  registerGitStateTool(
    "git_postflight",
    "Git postflight",
    "Verify git status, local HEAD, remote-tracking branch, and the remote branch after commits and push.",
  );
}
