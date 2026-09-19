import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowRegistry } from "./workflow-registry.js";

const source = (name: string) => `export const meta = {name: '${name}', description: 'Example'}; return null;`;

test("workflow registry preserves project boundaries, validates metadata, and atomically saves names", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "workflow-registry-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  const user = join(root, "personal");
  await mkdir(join(project, ".devspace", "workflows"), { recursive: true });
  await mkdir(outside); await mkdir(user);
  await writeFile(join(user, "review.js"), source("review"));
  await writeFile(join(project, ".devspace", "workflows", "review.js"), source("review"));
  await writeFile(join(project, ".devspace", "workflows", "invalid.js"), "throw new Error('must not execute')");
  const registry = new WorkflowRegistry({ userRoot: user });
  const found = await registry.discover(project);
  assert.equal(found.definitions[0]?.origin, "project");
  assert.equal(found.conflicts.length, 1);
  assert.equal(found.invalid.length, 1);
  const saves = await Promise.allSettled([1, 2].map(() => registry.save({
    workspaceRoot: project, source: source("original"), name: "saved", location: "project",
  })));
  assert.equal(saves.filter(({ status }) => status === "fulfilled").length, 1);
  assert.match(await readFile(join(project, ".devspace", "workflows", "saved.js"), "utf8"), /name: "saved"/);
  await assert.rejects(registry.resolvePath(project, join(outside, "x.js")), /WORKSPACE_NOT_ALLOWED/);
  await writeFile(join(outside, "escape.js"), source("escape"));
  await symlink(join(outside, "escape.js"), join(project, "escape.js"));
  await assert.rejects(registry.resolvePath(project, "escape.js"), /WORKSPACE_NOT_ALLOWED/);
  const small = new WorkflowRegistry({ userRoot: user, scriptBytes: 20 });
  await assert.rejects(small.resolvePath(project, ".devspace/workflows/review.js"), /size limit/);
  await mkdir(join(root, ".devspace", "workflows"), { recursive: true });
  await writeFile(join(root, ".devspace", "workflows", "outside.js"), source("outside"));
  assert.equal((await registry.discover(project)).definitions.some(({ name }) => name === "outside"), false);
});

test("workflow discovery rejects an escaping project definition directory", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workflow-registry-link-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(join(project, ".devspace"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "escape.js"), source("escape"));
  await symlink(outside, join(project, ".devspace", "workflows"));
  const result = await new WorkflowRegistry({ userRoot: join(root, "personal") }).discover(project);
  assert.deepEqual(result.definitions, []);
  assert.match(result.invalid[0]?.message ?? "", /symbolic link/);
});
