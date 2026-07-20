/**
 * Runtime diagnostics — PR #69 (selective: D. 运行诊断).
 *
 * Provides a local diagnostic entry point that reports runtime health
 * without exposing sensitive data (no tokens, cookies, keys, env vars,
 * or private file contents).
 *
 * Commands:
 *  - devspace-runtime diagnose: Node, npm, Git, shell, PowerShell path,
 *    DevSpace version, health, public metadata, session count, cleanup stats,
 *    recent errors, memory, output limit, contextIgnorePaths, PATH check.
 *  - devspace-runtime smoke: minimal end-to-end request test.
 *  - devspace-runtime costs: tool execution cost summary.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface DiagnoseInput {
  registrySnapshot?: Record<string, unknown>;
  costSnapshot?: Record<string, unknown>;
  configInfo?: {
    port?: number;
    inlineOutputCharacters?: number;
    contextIgnorePaths?: string[];
    shell?: string;
    widgets?: string;
    publicBaseUrl?: string;
  };
  recentErrors?: string[];
}

export interface DiagnoseOutput {
  node: string;
  npm: string;
  git: string;
  platform: string;
  arch: string;
  shell: string;
  powershellPath: string | null;
  devspaceVersion: string;
  processUptimeSec: number;
  memoryUsageMB: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  sessions: Record<string, unknown> | null;
  costs: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  recentErrors: string[];
  pathCheck: Array<{ command: string; available: boolean }>;
}

function safeExec(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return "unavailable";
  }
}

function checkPathCommand(cmd: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

export function runDiagnose(input: DiagnoseInput = {}): DiagnoseOutput {
  const mem = process.memoryUsage();

  const pathCommands = ["node", "npm", "git", "rg"];
  if (process.platform === "win32") {
    pathCommands.push("powershell", "taskkill");
  }

  // Find PowerShell path
  let powershellPath: string | null = null;
  if (process.platform === "win32") {
    try {
      powershellPath = safeExec("where", ["powershell"]).split(/\r?\n/)[0] || null;
    } catch {
      powershellPath = null;
    }
  }

  return {
    node: process.version,
    npm: safeExec("npm", ["--version"]),
    git: safeExec("git", ["--version"]),
    platform: process.platform,
    arch: process.arch,
    shell: input.configInfo?.shell ?? "auto",
    powershellPath,
    devspaceVersion: process.env.npm_package_version ?? "unknown",
    processUptimeSec: Math.round(process.uptime()),
    memoryUsageMB: {
      rss: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
      external: Math.round(mem.external / 1024 / 1024 * 10) / 10,
    },
    sessions: input.registrySnapshot ?? null,
    costs: input.costSnapshot ?? null,
    config: input.configInfo ?? null,
    recentErrors: (input.recentErrors ?? []).slice(-10),
    pathCheck: pathCommands.map((cmd) => ({
      command: cmd,
      available: checkPathCommand(cmd),
    })),
  };
}

export interface SmokeResult {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * Run a minimal smoke test. The caller provides async check functions.
 */
export async function runSmoke(
  checks: Array<{ name: string; fn: () => Promise<boolean | { ok: boolean; detail?: string }> }>,
): Promise<SmokeResult> {
  const steps: SmokeResult["steps"] = [];
  let allOk = true;
  for (const check of checks) {
    try {
      const result = await check.fn();
      const ok = typeof result === "boolean" ? result : result.ok;
      const detail = typeof result === "boolean" ? undefined : result.detail;
      steps.push({ name: check.name, ok, detail });
      if (!ok) allOk = false;
    } catch (err) {
      steps.push({
        name: check.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      allOk = false;
    }
  }
  return { ok: allOk, steps };
}
