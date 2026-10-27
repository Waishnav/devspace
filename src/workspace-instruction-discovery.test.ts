import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { walkWorkspaceInstructions } from "./workspace-instruction-discovery.js";

const limits = { maxDirectories: 10, maxEntries: 100, maxDurationMs: 60_000 };

test("instruction discovery completes small trees and skips dependency directories", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "node_modules", "package"), { recursive: true });
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions");
  await writeFile(join(root, "node_modules", "package", "AGENTS.md"), "dependency instructions");
  const files: string[] = [];
  assert.equal(await walkWorkspaceInstructions(root, (path) => { files.push(path); }, limits), true);
  assert.deepEqual(files, [join(root, "nested", "AGENTS.md")]);
});

test("directory budget stops the whole walk, including sibling subtrees", async (t) => {
  const root = await fixture(t);
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "AGENTS.md"), "instructions");
  }
  const files: string[] = [];
  assert.equal(await walkWorkspaceInstructions(root, (path) => { files.push(path); }, {
    ...limits, maxDirectories: 2,
  }), false);
  assert.equal(files.length, 1);
});

test("entry budget also bounds a flat directory with no subdirectories", async (t) => {
  const root = await fixture(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), "");
  let visited = 0;
  assert.equal(await walkWorkspaceInstructions(root, () => { visited++; }, {
    ...limits, maxEntries: 2,
  }), false);
  assert.equal(visited, 2);
});

test("expired discovery time budget does not start another directory", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "AGENTS.md"), "instructions");
  let visited = 0;
  assert.equal(await walkWorkspaceInstructions(root, () => { visited++; }, {
    ...limits, maxDurationMs: 0,
  }), false);
  assert.equal(visited, 0);
});

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
