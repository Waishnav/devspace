import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
  resolveCanonicalAllowedPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-roots-test-"));
try {
  const workspace = join(fixtureRoot, "workspace");
  const outside = join(fixtureRoot, "outside");
  await mkdir(join(workspace, "inside"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "secret\n");

  const outsideLink = join(workspace, "outside-link");
  await symlink(outside, outsideLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    resolveCanonicalAllowedPath(join(outsideLink, "secret.txt"), workspace, [workspace]),
    /outside allowed roots/,
  );
  await assert.rejects(
    resolveCanonicalAllowedPath(join(outsideLink, "new.txt"), workspace, [workspace]),
    /outside allowed roots/,
  );

  const insideLink = join(workspace, "inside-link");
  await symlink(join(workspace, "inside"), insideLink, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    await resolveCanonicalAllowedPath(join(insideLink, "new.txt"), workspace, [workspace]),
    join(workspace, "inside", "new.txt"),
  );

  const outsideAlias = join(outside, "workspace-link");
  await symlink(workspace, outsideAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    resolveCanonicalAllowedPath(join(outsideAlias, "inside"), workspace, [workspace]),
    /outside allowed roots/,
  );

  if (process.platform !== "win32") {
    const danglingLink = join(workspace, "dangling-link");
    await symlink(join(outside, "missing.txt"), danglingLink);
    await assert.rejects(
      resolveCanonicalAllowedPath(danglingLink, workspace, [workspace]),
      /Cannot resolve symbolic link/,
    );
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
