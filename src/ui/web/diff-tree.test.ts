import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffTree } from "./diff-tree.js";

test("diff tree lists directories before files and compacts single-child chains", () => {
  const tree = buildDiffTree([
    { path: "src/ui/web/main.tsx", additions: 3, removals: 1 },
    { path: "src/ui/web/web.css", additions: 2, removals: 0 },
    { path: "README.md", additions: 1, removals: 1 },
  ]);

  assert.deepEqual(tree.map((node) => [node.kind, node.name, node.additions, node.removals]), [
    ["directory", "src/ui/web", 5, 1],
    ["file", "README.md", 1, 1],
  ]);
  const [directory] = tree;
  assert.equal(directory?.kind === "directory" && directory.children.map((child) => child.path).join(","),
    "src/ui/web/main.tsx,src/ui/web/web.css");
});
