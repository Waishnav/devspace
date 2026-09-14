import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { Result, type Result as BetterResult } from "better-result";
import type {
  WorkspaceConversationBinding,
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import {
  createManagedWorktree,
  discardRestoredManagedWorktree,
  ManagedWorktreeError,
  restoreManagedWorktree,
  type ManagedWorktreeFeatureError,
} from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

type InitialAgentsFileSource = "global" | "workspace";

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

const openWorkspaceInputSchema = z.object({
  path: z.string(),
  mode: z.enum(["checkout", "worktree"]).optional(),
  baseRef: z.string().optional(),
});

type PathStats = Stats;

type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
};

const MAX_CACHED_WORKSPACES = 32;

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingCheckoutOpens = new Map<string, Promise<WorkspaceContext>>();
  private readonly pendingRestores = new Map<
    string,
    Promise<BetterResult<void, ManagedWorktreeFeatureError>>
  >();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const parsedPath = z.string().safeParse(input);

    const workspaceInput = parsedPath.success
      ? { path: parsedPath.data }
      : openWorkspaceInputSchema.parse(input);

    const conversationScopeId = openOptions.conversationScopeId;

    if (!conversationScopeId || !this.store) {
      return this.openNewWorkspace(workspaceInput);
    }

    const projectKey = await this.conversationProjectKey(workspaceInput);
    const mode = workspaceInput.mode ?? "checkout";

    if (mode === "worktree") {
      const context = await this.openWorktreeWorkspace(workspaceInput.path, workspaceInput.baseRef);

      return {
        ...context,
        // A new worktree always has its own workspace-specific context.
        includeBootstrapContext: true,
      };
    }

    const targetKey = this.conversationCheckoutTargetKey(projectKey);
    const operationKey = JSON.stringify([conversationScopeId, targetKey]);
    const pending = this.pendingCheckoutOpens.get(operationKey);

    if (pending) {
      const context = await pending;

      return {
        ...context,
        workspaceReused: true,
        includeBootstrapContext: false,
      };
    }

    const open = this.openConversationCheckout(
      workspaceInput,
      conversationScopeId,
      targetKey,
    );

    this.pendingCheckoutOpens.set(operationKey, open);

    try {
      return await open;
    } finally {
      if (this.pendingCheckoutOpens.get(operationKey) === open) {
        this.pendingCheckoutOpens.delete(operationKey);
      }
    }
  }

  private async openNewWorkspace(options: OpenWorkspaceInput): Promise<WorkspaceContext> {
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  private async openConversationCheckout(
    input: OpenWorkspaceInput,
    conversationScopeId: string,
    targetKey: string,
  ): Promise<WorkspaceContext> {
    const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);

    if (binding) {
      const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);

      if (reusableWorkspace) {
        const context = await this.reusedWorkspaceContext(reusableWorkspace);
        this.store?.touchConversationBinding(conversationScopeId, targetKey);

        return {
          ...context,
          includeBootstrapContext: false,
        };
      }

      this.workspaces.delete(binding.workspaceSessionId);
      this.store?.deleteConversationBinding(conversationScopeId, targetKey);
    }

    const context = await this.openCheckoutWorkspace(input.path);
    this.store?.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });

    return {
      ...context,
      includeBootstrapContext: true,
    };
  }

  private async findReusableCheckoutWorkspace(
    binding: WorkspaceConversationBinding,
  ): Promise<Workspace | undefined> {
    const session = this.store?.getSession(binding.workspaceSessionId);

    if (!session || session.status !== "active" || session.mode !== "checkout") {
      return undefined;
    }

    let root: string;

    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);

      if (!rootStats.isDirectory()) return undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }

      throw error;
    }

    const workspace = await this.getWorkspace(binding.workspaceSessionId);

    if (workspace.mode !== "checkout" || workspace.root !== root) return undefined;

    return workspace;
  }

  private async conversationProjectKey(input: OpenWorkspaceInput): Promise<string> {
    const path = assertAllowedPath(input.path, this.config.allowedRoots);

    return canonicalPath(path);
  }

  private conversationCheckoutTargetKey(projectKey: string): string {
    return JSON.stringify(["checkout", projectKey, null]);
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.get(workspaceId);

    if (workspace) {
      if (!this.store) {
        this.workspaces.delete(workspaceId);
        this.workspaces.set(workspaceId, workspace);

        return workspace;
      }

      const touched = this.store.touchSession(workspaceId);

      if (touched.isErr()) throw touched.error;

      if (touched.value) {
        this.workspaces.delete(workspaceId);
        this.workspaces.set(workspaceId, workspace);

        return workspace;
      }

      this.workspaces.delete(workspaceId);
    }

    let session: WorkspaceSession | undefined;

    if (this.store) {
      const sessionLookup = this.store.getSessionResult(workspaceId);

      if (sessionLookup.isErr()) throw sessionLookup.error;
      session = sessionLookup.value;
    }

    if (session?.status === "pruned") {
      const restored = await this.ensurePrunedWorkspaceRestored(session);

      if (restored.isErr()) throw restored.error;

      if (this.store) {
        const restoredLookup = this.store.getSessionResult(workspaceId);

        if (restoredLookup.isErr()) throw restoredLookup.error;
        session = restoredLookup.value;
      }
    }

    if (!session || session.status !== "active") {
      throw unavailableWorkspaceError(workspaceId);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);

    if (this.store) {
      const touched = this.store.touchSession(workspaceId);

      if (touched.isErr()) throw touched.error;

      if (!touched.value) throw unavailableWorkspaceError(workspaceId);
    }

    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      agentProfiles: [],
    };

    this.rememberWorkspace(restoredWorkspace);

    return restoredWorkspace;
  }

  private async ensurePrunedWorkspaceRestored(
    session: WorkspaceSession,
  ): Promise<BetterResult<void, ManagedWorktreeFeatureError>> {
    const pending = this.pendingRestores.get(session.id);

    if (pending) return pending;

    const restore = this.restorePrunedWorkspace(session);
    this.pendingRestores.set(session.id, restore);

    try {
      return await restore;
    } finally {
      if (this.pendingRestores.get(session.id) === restore) {
        this.pendingRestores.delete(session.id);
      }
    }
  }

  private async restorePrunedWorkspace(
    session: WorkspaceSession,
  ): Promise<BetterResult<void, ManagedWorktreeFeatureError>> {
    if (!this.store || session.mode !== "worktree" || !session.managed) {
      return Result.err(new ManagedWorktreeError({
        code: "WORKTREE_INVALID_STATE",
        workspaceId: session.id,
        operation: "reactivate",
        message: unavailableWorkspaceError(session.id).message,
      }));
    }

    const restored = await restoreManagedWorktree({
      session,
      worktreeRoot: this.config.worktreeRoot,
      allowedRoots: this.config.allowedRoots,
    });

    if (restored.isErr()) return restored;

    const reactivated = this.store.reactivateSession(session.id);

    if (reactivated.isErr() || !reactivated.value) {
      const discarded = await discardRestoredManagedWorktree({
        session,
        worktreeRoot: this.config.worktreeRoot,
        allowedRoots: this.config.allowedRoots,
      });

      if (discarded.isErr()) {
        return Result.err(new ManagedWorktreeError({
          code: "WORKTREE_RESTORE_FAILED",
          workspaceId: session.id,
          operation: "reactivate",
          message: `Restored workspace ${session.id}, but its persisted session could not be reactivated and the restored worktree could not be discarded.`,
          cause: {
            reactivate: reactivated.isErr() ? reactivated.error : undefined,
            discard: discarded.error,
          },
        }));
      }

      if (reactivated.isErr()) return reactivated;

      return Result.err(new ManagedWorktreeError({
        code: "WORKTREE_RESTORE_FAILED",
        workspaceId: session.id,
        operation: "reactivate",
        message: `Restored workspace ${session.id}, but its persisted session could not be reactivated.`,
      }));
    }

    return Result.ok(undefined);
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);

    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        inputPath,
      );

      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;

    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);

    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.rememberWorkspace(workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
  }

  private rememberWorkspace(workspace: Workspace): void {
    this.workspaces.delete(workspace.id);
    this.workspaces.set(workspace.id, workspace);

    if (!this.store) return;

    while (this.workspaces.size > MAX_CACHED_WORKSPACES) {
      const oldestWorkspaceId = this.workspaces.keys().next().value;

      if (!oldestWorkspaceId) break;
      this.workspaces.delete(oldestWorkspaceId);
    }
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);

    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }

      assertAllowedPath(sourceRoot, this.config.allowedRoots);

      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      const source = initialAgentsFileSource(path, root, agentDir);

      if (!source) continue;

      const content = await readResolvedContextFile(
        path,
        file.content,
        source,
        resolvedRoot,
      );

      if (content === undefined) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();

    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);

      if (realPath) loadedRealPaths.add(realPath);
    }

    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;

      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;

      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);

      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function unavailableWorkspaceError(workspaceId: string): Error {
  return new Error(
    `Unknown workspaceId: ${workspaceId}. Open the target project or worktree again and continue with the new workspaceId.`,
  );
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);

      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });

  return await ops.stat(path);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);

  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function initialAgentsFileSource(
  path: string,
  root: string,
  agentDir: string,
): InitialAgentsFileSource | undefined {
  if (isPathInsideRoot(path, agentDir)) return "global";

  if (isPathInsideRoot(path, root) && dirname(path) === root) return "workspace";

  return undefined;
}

async function readResolvedContextFile(
  path: string,
  fallbackContent: string,
  source: InitialAgentsFileSource,
  root: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);

    if (
      source === "workspace" &&
      (!isPathInsideRoot(resolvedPath, root) || dirname(resolvedPath) !== root)
    ) {
      return undefined;
    }

    return await readFile(resolvedPath, "utf8");
  } catch {
    return fallbackContent;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;

  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }

      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
