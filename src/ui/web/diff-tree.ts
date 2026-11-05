export interface DiffTreeFile {
  path: string;
  additions: number;
  removals: number;
}

export type DiffTreeNode =
  | { kind: "directory"; name: string; path: string; additions: number; removals: number; children: DiffTreeNode[] }
  | { kind: "file"; name: string; path: string; additions: number; removals: number };

interface MutableDirectory {
  name: string;
  path: string;
  additions: number;
  removals: number;
  directories: Map<string, MutableDirectory>;
  files: DiffTreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Builds a directory tree for a turn's changed files: directories first, then
 * files, each sorted by name, with single-child directory chains compacted
 * into one node (`src/ui/web`).
 */
export function buildDiffTree(files: ReadonlyArray<DiffTreeFile>): DiffTreeNode[] {
  const root = directory("", "");

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const name = segments.pop();

    if (!name) continue;

    const ancestors = [root];
    let current = root;

    for (const segment of segments) {
      const path = current.path ? `${current.path}/${segment}` : segment;
      let next = current.directories.get(segment);

      if (!next) {
        next = directory(segment, path);
        current.directories.set(segment, next);
      }

      current = next;
      ancestors.push(current);
    }

    current.files.push({ kind: "file", name, path: file.path, additions: file.additions, removals: file.removals });

    for (const ancestor of ancestors) {
      ancestor.additions += file.additions;
      ancestor.removals += file.removals;
    }
  }

  return toNodes(root);
}

function directory(name: string, path: string): MutableDirectory {
  return { name, path, additions: 0, removals: 0, directories: new Map(), files: [] };
}

function toNodes(parent: MutableDirectory): DiffTreeNode[] {
  const directories = [...parent.directories.values()]
    .sort((left, right) => collator.compare(left.name, right.name))
    .map((child) => compact({
      kind: "directory" as const,
      name: child.name,
      path: child.path,
      additions: child.additions,
      removals: child.removals,
      children: toNodes(child),
    }));

  const files = [...parent.files].sort((left, right) => collator.compare(left.name, right.name));

  return [...directories, ...files];
}

function compact(node: Extract<DiffTreeNode, { kind: "directory" }>): DiffTreeNode {
  let current = node;

  while (current.children.length === 1 && current.children[0]?.kind === "directory") {
    const only = current.children[0];
    current = { ...only, name: `${current.name}/${only.name}` };
  }

  return current;
}
