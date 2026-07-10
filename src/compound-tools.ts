import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  containsSecretValue,
  isGeneratedOrBinaryPath,
  isSecretLikePath,
  safeRealFile,
} from "./safe-inspection.js";
import {
  buildBoundedPayload,
  clampInteger,
  takeWithinCharacterBudget,
  type ToolMetrics,
} from "./tool-metrics.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 1024 * 1024;
const SKIPPED_DIRS = new Set([
  ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules",
]);

export interface InspectionSkillSummary {
  name: string;
  description?: string;
}

export interface InspectionAgentSummary {
  name: string;
  provider: string;
  available?: boolean;
  writeMode?: string;
}

export interface WorkspaceInspectionContext {
  root: string;
  instructionPaths: string[];
  skills: InspectionSkillSummary[];
  agentProviders: InspectionAgentSummary[];
  agentProfiles: InspectionAgentSummary[];
}

export interface ProjectSnapshotResult extends Record<string, unknown> {
  branch: string | null;
  dirty: boolean;
  changedFiles: string[];
  diffStat: string;
  package: {
    name?: string;
    version?: string;
    scripts: string[];
  };
  applicableInstructions: string[];
  skills: InspectionSkillSummary[];
  agentProviders: InspectionAgentSummary[];
  agentProfiles: InspectionAgentSummary[];
  codeGraph: {
    detected: boolean;
    available: false;
    reason: "not_initialized" | "adapter_unavailable";
  };
  recommendedTestCommand?: string;
  recommendedBuildCommand?: string;
  metrics: ToolMetrics;
}

export async function projectSnapshot(
  context: WorkspaceInspectionContext,
  options: { maxCharacters?: number } = {},
): Promise<ProjectSnapshotResult> {
  const startedAt = performance.now();
  const maxCharacters = clampInteger(options.maxCharacters, 12_000, 2_000, 50_000);
  const [branchResult, statusResult, statResult, packageInfo] = await Promise.all([
    git(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(context.root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(context.root, ["diff", "--no-ext-diff", "--no-textconv", "--shortstat", "HEAD", "--"]),
    readPackageSummary(context.root),
  ]);
  const rawChangedFiles = statusResult.ok ? parseStatusPaths(statusResult.stdout) : [];
  const detected = existsSync(resolve(context.root, ".codegraph"));

  return buildBoundedPayload({
    startedAt,
    maxCharacters,
    build: (contentBudget) => {
      const files = takeWithinCharacterBudget(rawChangedFiles, Math.floor(contentBudget * 0.28));
      const instructions = takeWithinCharacterBudget(
        context.instructionPaths.map((path) => displayPath(path, context.root)),
        Math.floor(contentBudget * 0.18),
      );
      const skills = takeWithinCharacterBudget(
        context.skills.map((skill) => ({
          name: skill.name.slice(0, 100),
          ...(skill.description ? { description: skill.description.slice(0, 160) } : {}),
        })),
        Math.floor(contentBudget * 0.18),
      );
      const providers = takeWithinCharacterBudget(
        context.agentProviders,
        Math.floor(contentBudget * 0.13),
      );
      const profiles = takeWithinCharacterBudget(
        context.agentProfiles,
        Math.floor(contentBudget * 0.13),
      );
      const truncated = files.truncated
        || instructions.truncated
        || skills.truncated
        || providers.truncated
        || profiles.truncated;
      const returnedItems = files.items.length
        + instructions.items.length
        + skills.items.length
        + providers.items.length
        + profiles.items.length;

      return {
        payload: {
          branch: branchResult.ok ? branchResult.stdout.trim() || null : null,
          dirty: rawChangedFiles.length > 0,
          changedFiles: files.items,
          diffStat: statResult.ok ? statResult.stdout.trim().slice(0, 500) : "",
          package: packageInfo,
          applicableInstructions: instructions.items,
          skills: skills.items,
          agentProviders: providers.items,
          agentProfiles: profiles.items,
          codeGraph: {
            detected,
            available: false as const,
            reason: detected ? "adapter_unavailable" as const : "not_initialized" as const,
          },
          ...(recommendedCommand(packageInfo.scripts, "test")
            ? { recommendedTestCommand: recommendedCommand(packageInfo.scripts, "test") }
            : {}),
          ...(recommendedCommand(packageInfo.scripts, "build")
            ? { recommendedBuildCommand: recommendedCommand(packageInfo.scripts, "build") }
            : {}),
        },
        returnedItems,
        truncated,
      };
    },
  });
}

export interface FocusedContextResult extends Record<string, unknown> {
  relevantFiles: string[];
  relevantSymbols: Array<{ name: string; path: string; line: number }>;
  searchMatches: Array<{ path: string; line: number }>;
  applicableInstructions: string[];
  impactCandidates: string[];
  recommendedReads: string[];
  detectionMethod: "bounded_text_fallback" | "codegraph_adapter_unavailable_fallback";
  metrics: ToolMetrics;
}

export async function focusedContext(
  context: WorkspaceInspectionContext,
  options: {
    focus: string;
    paths?: string[];
    maxFiles?: number;
    maxCharacters?: number;
  },
): Promise<FocusedContextResult> {
  const startedAt = performance.now();
  const focus = options.focus.normalize("NFKC").trim().slice(0, 300);
  if (!focus) throw new Error("focus is required.");
  const maxFiles = clampInteger(options.maxFiles, 8, 1, 25);
  const maxCharacters = clampInteger(options.maxCharacters, 12_000, 2_000, 50_000);
  const scopes = await resolveScopes(context.root, options.paths);
  const candidates = await collectCandidateFiles(context.root, scopes, 500);
  const focusTokens = searchableTokens(focus);
  candidates.files.sort((a, b) => filenameScore(b, focusTokens) - filenameScore(a, focusTokens));

  const relevantFiles: string[] = [];
  const relevantSymbols: Array<{ name: string; path: string; line: number }> = [];
  const searchMatches: Array<{ path: string; line: number }> = [];
  let scannedBytes = 0;
  let scanTruncated = candidates.truncated || candidates.files.length > 120;

  for (const path of candidates.files.slice(0, 120)) {
    if (relevantFiles.length >= maxFiles || scannedBytes >= 3_000_000) {
      scanTruncated = true;
      break;
    }
    const content = await readBoundedTextFile(path, context.root, 96_000);
    if (content === undefined) continue;
    scannedBytes += content.length;
    const display = displayPath(path, context.root);
    const lines = content.split(/\r?\n/);
    let matchedFile = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const normalizedLine = line.normalize("NFKC").toLocaleLowerCase();
      if (!focusTokens.some((token) => normalizedLine.includes(token))) continue;
      matchedFile = true;
      if (searchMatches.length < maxFiles * 5) {
        searchMatches.push({ path: display, line: index + 1 });
      }
      const symbol = extractSymbol(line);
      if (symbol && relevantSymbols.length < maxFiles * 3) {
        relevantSymbols.push({ name: symbol, path: display, line: index + 1 });
      }
    }
    if (matchedFile) relevantFiles.push(display);
  }

  const instructionPaths = context.instructionPaths
    .filter((path) => scopes.some((scope) =>
      isPathInsideRoot(path, scope) || isPathInsideRoot(scope, dirname(path))))
    .map((path) => displayPath(path, context.root));
  const codeGraphDetected = existsSync(resolve(context.root, ".codegraph"));

  return buildBoundedPayload({
    startedAt,
    maxCharacters,
    build: (contentBudget) => {
      const files = takeWithinCharacterBudget(relevantFiles, Math.floor(contentBudget * 0.18));
      const symbols = takeWithinCharacterBudget(relevantSymbols, Math.floor(contentBudget * 0.22));
      const matches = takeWithinCharacterBudget(searchMatches, Math.floor(contentBudget * 0.22));
      const instructions = takeWithinCharacterBudget(instructionPaths, Math.floor(contentBudget * 0.13));
      const impact = takeWithinCharacterBudget(relevantFiles, Math.floor(contentBudget * 0.1));
      const reads = takeWithinCharacterBudget(relevantFiles, Math.floor(contentBudget * 0.1));
      const truncated = scanTruncated
        || files.truncated || symbols.truncated || matches.truncated
        || instructions.truncated || impact.truncated || reads.truncated;
      return {
        payload: {
          relevantFiles: files.items,
          relevantSymbols: symbols.items,
          searchMatches: matches.items,
          applicableInstructions: instructions.items,
          impactCandidates: impact.items,
          recommendedReads: reads.items,
          detectionMethod: codeGraphDetected
            ? "codegraph_adapter_unavailable_fallback" as const
            : "bounded_text_fallback" as const,
        },
        returnedItems: files.items.length + symbols.items.length + matches.items.length,
        truncated,
      };
    },
  });
}

export interface ReviewChangesResult extends Record<string, unknown> {
  changedFiles: Array<{ path: string; status: string }>;
  diffStat: string;
  summary: string;
  riskCandidates: string[];
  suspiciousChanges: Array<{ rule: string; file: string; line?: number }>;
  testRecommendations: string[];
  truncated: boolean;
  metrics: ToolMetrics;
}

export async function reviewChanges(
  context: WorkspaceInspectionContext,
  options: { scope?: string; baseRef?: string; maxCharacters?: number } = {},
): Promise<ReviewChangesResult> {
  const startedAt = performance.now();
  const maxCharacters = clampInteger(options.maxCharacters, 12_000, 2_000, 50_000);
  const baseRef = options.baseRef?.trim() || "HEAD";
  validateBaseRef(baseRef);
  await requireGitRef(context.root, baseRef);
  const pathspec = options.scope ? await gitPathspec(context.root, options.scope) : undefined;
  const suffix = pathspec ? ["--", pathspec] : ["--"];
  const [nameStatus, status, diffStat, diff, packageInfo] = await Promise.all([
    git(context.root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", baseRef, ...suffix]),
    git(context.root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", ...suffix]),
    git(context.root, ["diff", "--no-ext-diff", "--no-textconv", "--shortstat", baseRef, ...suffix]),
    git(context.root, ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", baseRef, ...suffix]),
    readPackageSummary(context.root),
  ]);
  const changed = new Map<string, string>();
  if (nameStatus.ok) {
    for (const entry of parseNameStatus(nameStatus.stdout)) changed.set(entry.path, entry.status);
  }
  if (status.ok) {
    for (const path of parseStatusPaths(status.stdout)) {
      if (!changed.has(path)) changed.set(path, "untracked");
    }
  }
  const changedFiles = Array.from(changed, ([path, changeStatus]) => ({ path, status: changeStatus }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const suspicious = diff.ok ? inspectDiff(diff.stdout.slice(0, 300_000)) : [];
  const riskCandidates = Array.from(new Set(suspicious.map((item) => item.rule)));
  const testRecommendations = ["typecheck", "test", "build"]
    .map((name) => recommendedCommand(packageInfo.scripts, name))
    .filter((command): command is string => command !== undefined);

  const result = buildBoundedPayload({
    startedAt,
    maxCharacters,
    build: (contentBudget) => {
      const files = takeWithinCharacterBudget(changedFiles, Math.floor(contentBudget * 0.4));
      const risks = takeWithinCharacterBudget(riskCandidates, Math.floor(contentBudget * 0.15));
      const findings = takeWithinCharacterBudget(suspicious, Math.floor(contentBudget * 0.3));
      const tests = takeWithinCharacterBudget(testRecommendations, Math.floor(contentBudget * 0.1));
      const truncated = files.truncated || risks.truncated || findings.truncated || tests.truncated
        || (diff.ok && diff.stdout.length > 300_000);
      return {
        payload: {
          changedFiles: files.items,
          diffStat: diffStat.ok ? diffStat.stdout.trim().slice(0, 500) : "",
          summary: `${changedFiles.length} changed file(s); ${suspicious.length} suspicious pattern(s).`,
          riskCandidates: risks.items,
          suspiciousChanges: findings.items,
          testRecommendations: tests.items,
          truncated,
        },
        returnedItems: files.items.length + findings.items.length,
        truncated,
      };
    },
  });

  return { ...result, truncated: result.metrics.truncated };
}

async function readPackageSummary(root: string): Promise<{
  name?: string;
  version?: string;
  scripts: string[];
}> {
  const packagePath = resolve(root, "package.json");
  const realFile = await safeRealFile(packagePath, root);
  if (!realFile || isSecretLikePath(realFile)) return { scripts: [] };
  try {
    const info = await stat(realFile);
    if (info.size > 512_000) return { scripts: [] };
    const parsed = JSON.parse(await readFile(realFile, "utf8")) as Record<string, unknown>;
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? Object.keys(parsed.scripts as Record<string, unknown>)
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/.test(name))
        .slice(0, 100)
      : [];
    const packageName = typeof parsed.name === "string" && !containsSecretValue(parsed.name)
      ? parsed.name.slice(0, 200)
      : undefined;
    const packageVersion = typeof parsed.version === "string" && !containsSecretValue(parsed.version)
      ? parsed.version.slice(0, 50)
      : undefined;
    return {
      ...(packageName ? { name: packageName } : {}),
      ...(packageVersion ? { version: packageVersion } : {}),
      scripts,
    };
  } catch {
    return { scripts: [] };
  }
}

function recommendedCommand(scripts: string[], name: string): string | undefined {
  if (!scripts.includes(name)) return undefined;
  return name === "test" ? "npm test" : `npm run ${name}`;
}

async function resolveScopes(root: string, paths: string[] | undefined): Promise<string[]> {
  if (!paths || paths.length === 0) return [await realpath(root)];
  const scopes: string[] = [];
  for (const path of paths.slice(0, 25)) {
    const resolved = resolveAllowedPath(path, root, [root]);
    const real = await realpath(resolved);
    const realRoot = await realpath(root);
    if (!isPathInsideRoot(real, realRoot)) throw new Error(`Path is outside workspace root: ${path}`);
    scopes.push(real);
  }
  return scopes;
}

async function collectCandidateFiles(
  root: string,
  scopes: string[],
  hardLimit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const realRoot = await realpath(root);

  const visit = async (path: string): Promise<void> => {
    if (files.length >= hardLimit) {
      truncated = true;
      return;
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.isFile()) {
      const realFile = await safeRealFile(path, realRoot);
      if (!realFile || isSecretLikePath(realFile) || isGeneratedOrBinaryPath(realFile)) return;
      files.push(realFile);
      return;
    }
    if (!info.isDirectory()) return;
    let realDirectory: string;
    try {
      realDirectory = await realpath(path);
    } catch {
      return;
    }
    if (!isPathInsideRoot(realDirectory, realRoot)) return;
    let directory;
    try {
      directory = await opendir(path);
    } catch {
      return;
    }
    for await (const entry of directory) {
      if (files.length >= hardLimit) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      await visit(resolve(path, entry.name));
    }
  };

  for (const scope of scopes) await visit(scope);
  return { files, truncated };
}

async function readBoundedTextFile(
  path: string,
  root: string,
  maxBytes: number,
): Promise<string | undefined> {
  const realFile = await safeRealFile(path, root);
  if (!realFile || isSecretLikePath(realFile) || isGeneratedOrBinaryPath(realFile)) return undefined;
  try {
    const info = await stat(realFile);
    if (info.size > maxBytes) return undefined;
    const content = await readFile(realFile);
    if (content.includes(0)) return undefined;
    return content.toString("utf8");
  } catch {
    return undefined;
  }
}

function searchableTokens(focus: string): string[] {
  const normalized = focus.toLocaleLowerCase();
  const values = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return Array.from(new Set([normalized, ...values])).filter((value) => value.length >= 2).slice(0, 12);
}

function filenameScore(path: string, focusTokens: string[]): number {
  const name = basename(path).toLocaleLowerCase();
  return focusTokens.reduce((score, token) => score + (name.includes(token) ? 1 : 0), 0);
}

function extractSymbol(line: string): string | undefined {
  const match = line.match(/\b(?:class|interface|type|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/);
  return match?.[1];
}

function displayPath(path: string, root: string): string {
  const lexicalPath = resolve(path);
  const lexicalRoot = resolve(root);
  let comparablePath = lexicalPath;
  let comparableRoot = lexicalRoot;
  if (!isPathInsideRoot(lexicalPath, lexicalRoot)) {
    try {
      comparablePath = realpathSync(lexicalPath);
      comparableRoot = realpathSync(lexicalRoot);
    } catch {
      // Keep lexical paths when either side does not exist.
    }
  }
  const relationship = relative(comparableRoot, comparablePath);
  if (relationship === "" || relationship === ".") return ".";
  if (relationship === ".." || relationship.startsWith(`..${sep}`)) return resolve(path).split(sep).join("/");
  return relationship.split(sep).join("/");
}

function parseStatusPaths(output: string): string[] {
  const tokens = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return Array.from(new Set(paths)).sort();
}

function parseNameStatus(output: string): Array<{ path: string; status: string }> {
  const tokens = output.split("\0").filter(Boolean);
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] ?? "";
    const path = tokens[index + 1];
    if (!path) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = tokens[index + 2];
      if (destination) entries.push({ path: destination, status });
      index += 2;
    } else {
      entries.push({ path, status });
      index += 1;
    }
  }
  return entries;
}

function inspectDiff(diff: string): Array<{ rule: string; file: string; line?: number }> {
  const findings: Array<{ rule: string; file: string; line?: number }> = [];
  let file = "unknown";
  let nextLine: number | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      nextLine = undefined;
      continue;
    }
    const hunk = line.match(/^@@[^+]*\+(\d+)/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const value = line.slice(1);
    const add = (rule: string) => {
      if (!findings.some((item) => item.rule === rule && item.file === file && item.line === nextLine)) {
        findings.push({ rule, file, ...(nextLine === undefined ? {} : { line: nextLine }) });
      }
    };
    if (containsSecretValue(value)) add("potential_secret_value");
    if (/\b(?:eval|exec)\s*\(/.test(value)) add("dynamic_code_execution");
    if (/chmod\s+777|dangerouslySetInnerHTML/.test(value)) add("dangerous_permission_or_html");
    if (/\bas\s+any\b|:\s*any\b/.test(value)) add("type_safety_escape");
    if (/oauth|permissions?|allowed[_-]?roots?|iam/i.test(file)) add("permission_boundary_changed");
    if (/package(?:-lock)?\.json$|pnpm-lock|yarn\.lock$/.test(file)) add("dependency_manifest_changed");
    if (nextLine !== undefined) nextLine += 1;
    if (findings.length >= 100) break;
  }
  return findings;
}

function validateBaseRef(baseRef: string): void {
  if (!baseRef || baseRef.length > 200 || baseRef.startsWith("-") || /[\0-\x1f\x7f]/.test(baseRef)) {
    throw new Error(`Invalid baseRef: ${baseRef}`);
  }
}

async function requireGitRef(root: string, baseRef: string): Promise<void> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]);
  if (!result.ok) throw new Error(`Unknown baseRef: ${baseRef}`);
}

async function gitPathspec(root: string, scope: string): Promise<string> {
  const absolute = resolveAllowedPath(scope, root, [root]);
  const realRoot = await realpath(root);
  let realScope: string;
  try {
    realScope = await realpath(absolute);
  } catch {
    realScope = absolute;
  }
  if (!isPathInsideRoot(realScope, realRoot)) throw new Error(`Path is outside workspace root: ${scope}`);
  const relationship = relative(realRoot, realScope).split(sep).join("/");
  return `:(literal)${relationship || "."}`;
}

async function git(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: MAX_GIT_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    const stdout = typeof error === "object" && error && "stdout" in error && typeof error.stdout === "string"
      ? error.stdout
      : "";
    return { ok: false, stdout };
  }
}
