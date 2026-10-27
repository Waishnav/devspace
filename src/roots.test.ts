import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

const home = homedir();

test("home expansion rewrites only the current user's ~ prefix", () => {
  assert.equal(expandHomePath("~"), home);
  assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
  assert.equal(expandHomePath("~user/project"), "~user/project");
  assert.equal(expandHomePath("$HOME/project"), "$HOME/project");
});

test("~ paths are allowed under absolute and ~ allowed roots", () => {
  assert.equal(
    assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
    resolve(home, "personal", "devspace"),
  );

  assert.equal(
    assertAllowedPath("~/personal/devspace", ["~/personal"]),
    resolve(home, "personal", "devspace"),
  );
});

test("~ paths resolve against the home directory instead of the working directory", () => {
  // Home expansion applies before working-directory resolution, so a `~` path
  // resolves against the home directory rather than becoming a literal `~`
  // directory inside the workspace.
  assert.equal(
    resolveAllowedPath("~/personal/devspace", "/workspace", [join(home, "personal")]),
    resolve(home, "personal", "devspace"),
  );
});

test("~ paths outside allowed roots are denied", () => {
  // A `~` path outside the allowed roots is denied instead of being silently
  // mapped inside the workspace. Skill reads rely on this: the denial lets the
  // read fall through to the skill-path resolver.
  assert.throws(
    () => {
      const workspace = resolve(home, "workspace");
      return resolveAllowedPath("~/file.txt", workspace, [workspace]);
    },
    /Path is outside allowed roots/,
  );
});

test("Windows paths on another drive are outside allowed roots", { skip: process.platform !== "win32" }, () => {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
});
