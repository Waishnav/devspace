import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, link, lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parseWorkflowScript, renameWorkflowMeta } from "./workflow-script.js";
import type { ParsedWorkflowScript, WorkflowMeta } from "./workflow-types.js";

export type WorkflowDefinitionOrigin = "project" | "user" | "package";

export interface WorkflowDefinition {
  name: string;
  sourcePath: string;
  sourceHash: string;
  origin: WorkflowDefinitionOrigin;
  namespace?: string;
  meta: WorkflowMeta;
  source: string;
  parsed: ParsedWorkflowScript;
}

export interface InvalidWorkflowDefinition {
  sourcePath: string;
  origin: WorkflowDefinitionOrigin;
  message: string;
}

export interface WorkflowDiscoveryResult {
  definitions: WorkflowDefinition[];
  invalid: InvalidWorkflowDefinition[];
  conflicts: Array<{ name: string; selectedPath: string; ignoredPath: string }>;
}

export interface WorkflowRegistryOptions {
  userRoot?: string;
  packageRoots?: readonly string[];
  scriptBytes?: number;
  allowedRoots?: readonly string[];
}

/** Discovers source files without executing them. Nearest project definition wins. */
export class WorkflowRegistry {
  private readonly userRoot: string;
  private readonly packageRoots: readonly string[];
  private readonly scriptBytes: number;
  private readonly allowedRoots?: readonly string[];

  constructor(options: WorkflowRegistryOptions = {}) {
    this.userRoot = resolve(options.userRoot ?? join(homedir(), ".devspace", "workflows"));
    this.packageRoots = options.packageRoots?.map((root) => resolve(root)) ?? [];
    this.scriptBytes = options.scriptBytes ?? 256 * 1024;
    this.allowedRoots = options.allowedRoots;
  }

  async discover(workspaceRoot: string): Promise<WorkflowDiscoveryResult> {
    const roots: Array<{ path: string; origin: WorkflowDefinitionOrigin; namespace?: string }> = [];
    for (const projectRoot of await projectWorkflowRoots(workspaceRoot, this.allowedRoots)) {
      roots.push({ path: projectRoot, origin: "project" });
    }
    roots.push({ path: this.userRoot, origin: "user" });
    for (const packageRoot of this.packageRoots) {
      roots.push({ path: packageRoot, origin: "package", namespace: packageNamespace(packageRoot) });
    }

    const definitions = new Map<string, WorkflowDefinition>();
    const invalid: InvalidWorkflowDefinition[] = [];
    const conflicts: WorkflowDiscoveryResult["conflicts"] = [];
    for (const root of roots) {
      if (root.origin === "project") {
        try {
          const [project, directory] = await Promise.all([realpath(dirname(dirname(root.path))), realpath(root.path)]);
          if (!isWithin(project, directory)) throw new Error("Workflow directory leaves its project through a symbolic link.");
        } catch (error) {
          if (!isMissing(error)) invalid.push({ sourcePath: root.path, origin: root.origin, message: errorMessage(error) });
          continue;
        }
      }
      for (const sourcePath of await javascriptFiles(root.path)) {
        try {
          const source = await readAuthorizedFile(root.path, sourcePath, this.scriptBytes);
          const parsed = parseWorkflowScript(source, { filename: sourcePath, maxBytes: this.scriptBytes });
          const publicName = root.namespace ? `${root.namespace}:${parsed.meta.name}` : parsed.meta.name;
          const definition: WorkflowDefinition = {
            name: publicName,
            sourcePath,
            sourceHash: createHash("sha256").update(source).digest("hex"),
            origin: root.origin,
            namespace: root.namespace,
            meta: parsed.meta,
            source,
            parsed,
          };
          const existing = definitions.get(publicName);
          if (existing) conflicts.push({ name: publicName, selectedPath: existing.sourcePath, ignoredPath: sourcePath });
          else definitions.set(publicName, definition);
        } catch (error) {
          invalid.push({ sourcePath, origin: root.origin, message: errorMessage(error) });
        }
      }
    }
    return { definitions: [...definitions.values()], invalid, conflicts };
  }

  async resolveName(workspaceRoot: string, name: string): Promise<WorkflowDefinition> {
    const discovered = await this.discover(workspaceRoot);
    const definition = discovered.definitions.find((item) => item.name === name);
    if (!definition) throw new Error(`WORKFLOW_NOT_FOUND: ${name}`);
    return definition;
  }

  async resolvePath(workspaceRoot: string, sourcePath: string, relativeTo?: string): Promise<WorkflowDefinition> {
    const absolute = resolve(relativeTo ?? workspaceRoot, sourcePath);
    const discovered = await this.discover(workspaceRoot);
    const registered = discovered.definitions.find((item) => item.sourcePath === absolute);
    if (registered) return registered;
    if (!isWithin(workspaceRoot, absolute)) throw new Error("WORKSPACE_NOT_ALLOWED");
    const source = await readAuthorizedFile(workspaceRoot, absolute, this.scriptBytes);
    const parsed = parseWorkflowScript(source, { filename: absolute, maxBytes: this.scriptBytes });
    return {
      name: parsed.meta.name,
      sourcePath: absolute,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      origin: "project",
      meta: parsed.meta,
      source,
      parsed,
    };
  }

  async save(input: {
    workspaceRoot: string;
    source: string;
    name: string;
    location: "project" | "user";
    replace?: boolean;
  }): Promise<WorkflowDefinition> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) throw new Error("WORKFLOW_META_INVALID");
    const parsed = parseWorkflowScript(input.source, { maxBytes: this.scriptBytes });
    const source = parsed.meta.name === input.name
      ? input.source
      : renameWorkflowMeta(input.source, input.name);
    const root = input.location === "project"
      ? join(await realpath(input.workspaceRoot), ".devspace", "workflows")
      : this.userRoot;
    await ensureWritableRoot(root);
    const path = join(root, `${input.name}.js`);
    if (!input.replace && await exists(path)) throw new Error(`Workflow already exists: ${input.name}`);
    if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new Error("Refusing to replace a symbolic link.");
    const temporary = join(root, `.${input.name}.${randomUUID()}.tmp`);
    await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      if (input.replace) await rename(temporary, path);
      else {
        await link(temporary, path);
        await unlink(temporary);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return this.resolvePath(input.workspaceRoot, path);
  }
}

async function projectWorkflowRoots(workspaceRoot: string, allowedRoots: readonly string[] = [workspaceRoot]): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(join(current, ".devspace", "workflows"));
    if (await exists(join(current, ".git"))) return roots;
    const parent = dirname(current);
    if (parent === current || !allowedRoots.some((root) => isWithin(root, parent))) break;
    current = parent;
  }
  return [join(resolve(workspaceRoot), ".devspace", "workflows")];
}

async function javascriptFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(root, entry.name)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readAuthorizedFile(root: string, path: string, maxBytes: number): Promise<string> {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!isWithin(realRoot, realPath)) throw new Error("WORKSPACE_NOT_ALLOWED");
  const handle = await open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Workflow script exceeds the source size limit or is not a file.");
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("Workflow script exceeds the source size limit.");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

async function ensureWritableRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const resolved = await realpath(root);
  if (resolved !== resolve(root)) throw new Error("Workflow directory contains a symbolic link.");
  await access(resolved, constants.W_OK);
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function packageNamespace(root: string): string {
  return dirname(root).split(/[\\/]/).filter(Boolean).at(-1) ?? "package";
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
