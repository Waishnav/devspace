#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import { LocalAgentDaemon, writeLocalAgentDaemonLog } from "./local-agent-daemon.js";
import {
  LocalAgentDaemonAlreadyRunningError,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { executionConfigRevision } from "./workflow-config.js";
import { createWorkflowManager } from "./workflow-manager.js";
import { openDatabase } from "./db/client.js";
import { WorkflowStore } from "./workflow-store.js";
import { WorkflowRegistry } from "./workflow-registry.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { assertAllowedPath, expandHomePath } from "./roots.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const config = loadConfig();
const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
const paths = localAgentDaemonPaths(config.stateDir);
const log = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => writeLocalAgentDaemonLog(paths, level, event, fields);
const database = openDatabase(paths.stateDir);
const store = new LocalAgentStore(database);
const workspaceStore = new SqliteWorkspaceStore(config.stateDir);
const workspaces = new WorkspaceRegistry(config, workspaceStore);
const manager = new LocalAgentManager({
  store,
  drivers: createLocalAgentDrivers({ subagents: config.subagents }),
  pool: new LocalAgentRuntimePool({ logger: log }),
  loadProfiles: (workspaceRoot, workspaceId) => {
    const session = workspaceId ? workspaceStore.getSession(workspaceId) : undefined;
    const profileRoot = session?.mode === "worktree" && session.managed && session.sourceRoot
      ? session.sourceRoot : workspaceRoot;
    return loadLocalAgentProfiles(config, profileRoot, { includeDisabled: true });
  },
  agentDir: config.agentDir,
  allowedRoots: config.allowedRoots,
  validateWorkspaceScope: (scope) => {
    if (!scope.workspaceId) return scope.workspaceRoot;
    const session = workspaceStore.getSession(scope.workspaceId);
    if (!session || session.status !== "active" || resolve(session.root) !== resolve(scope.workspaceRoot)) {
      throw new Error("Workspace identity is unavailable or does not match its root.");
    }
    const canonicalAllowed = (path: string, roots: string[]) => {
      assertAllowedPath(path, roots);
      const canonicalRoots = roots.flatMap((root) => {
        try { return [realpathSync(root)]; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      });
      return assertAllowedPath(realpathSync(path), canonicalRoots);
    };
    if (session.mode === "worktree") {
      if (!session.managed || !session.sourceRoot) throw new Error("Managed workspace source is unavailable.");
      canonicalAllowed(session.sourceRoot, config.allowedRoots);
      canonicalAllowed(session.root, [config.worktreeRoot]);
    } else canonicalAllowed(session.root, config.allowedRoots);
    return session.root;
  },
  logger: log,
  subagents: config.subagents,
});
const workflows = config.workflows?.enabled ? createWorkflowManager({
  stateDir: config.stateDir, agents: manager, agentStore: store, config: config.workflows,
  store: new WorkflowStore(database),
  registry: new WorkflowRegistry({
    userRoot: join(config.configDir, "workflows"), allowedRoots: config.allowedRoots,
    packageRoots: config.workflows.packageRoots.map((path) => resolve(config.configDir, expandHomePath(path))),
    scriptBytes: config.workflows.limits.scriptBytes,
  }),
  validateScope: async (scope) => {
    const workspace = await workspaces.getWorkspace(scope.workspaceId);
    if (workspace.root !== scope.workspaceRoot) throw new Error("WORKSPACE_NOT_ALLOWED: Workspace root does not match its stored identity.");
    return { workspaceId: workspace.id, workspaceRoot: workspace.root };
  },
  inspectWorktree: async ({ scope, worktree }) => {
    const workspace = await workspaces.getWorkspace(scope.workspaceId);
    if (workspace.root !== scope.workspaceRoot) throw new Error("Managed workspace identity changed.");
    const [status, head] = await Promise.all([
      promisify(execFile)("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: workspace.root }),
      promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: workspace.root }),
    ]);
    return { changed: Boolean(status.stdout.trim()) || head.stdout.trim() !== worktree.baseSha };
  },
  createWorktree: async ({ scope }) => {
    const source = await workspaces.getWorkspace(scope.workspaceId);
    const baseRef = source.mode === "worktree"
      ? (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: source.root })).stdout.trim()
      : undefined;
    const { workspace } = await workspaces.openWorkspace({ path: source.sourceRoot ?? source.root, mode: "worktree", baseRef });
    return { workspaceId: workspace.id, workspaceRoot: workspace.root, baseSha: workspace.worktree!.baseSha };
  },
}) : undefined;
const daemon = new LocalAgentDaemon({
  stateDir: paths.stateDir,
  manager,
  workflows,
  configRevision: executionConfigRevision(config),
  onLockAcquired: () => {
    const reconciled = manager.reconcileActiveRuns();
    if (reconciled.isErr()) throw reconciled.error;
    workflows?.reconcileActiveRuns();
  },
  onClosed: () => { workspaceStore.close(); database.close(); if (!shuttingDown) process.exit(0); },
  idleShutdownMs: parseIdleShutdownMs(process.env.DEVSPACE_AGENTD_IDLE_TIMEOUT_MS),
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    log("error", "daemon_forced_shutdown", {
      activeTurns: manager.activeTurnCount,
      runtimeCount: manager.runtimeCount,
    });
    // Active records intentionally remain durable. The next daemon startup
    // reconciles them to error while preserving provider continuation data.
    process.exit(1);
  }, parseShutdownTimeoutMs(process.env.DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS));
  forceTimer.unref();
  void daemon.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await daemon.start();
} catch (error) {
  if (error instanceof LocalAgentDaemonAlreadyRunningError) {
    await manager.close();
    process.exit(0);
  }
  log("error", "daemon_start_failed", { error: error instanceof Error ? error.message : String(error) });
  await manager.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseIdleShutdownMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 30_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_IDLE_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}

function parseShutdownTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}
