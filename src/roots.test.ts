import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

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
  resolveAllowedPath("~/personal/devspace", "/some/other/cwd", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/personal/devspace", home, [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/personal/devspace", "/some/other/cwd", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.throws(
  () => resolveAllowedPath("~/outside", home, [join(home, "personal")]),
  /Path is outside allowed roots/,
);

assert.throws(
  () => resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  /Path is outside allowed roots/,
);

assert.equal(
  resolveAllowedPath("relative/path", "/workspace", ["/workspace"]),
  resolve("/workspace", "relative/path"),
);

assert.equal(
  resolveAllowedPath("./file.txt", join(home, "personal"), [join(home, "personal")]),
  resolve(home, "personal", "file.txt"),
);

assert.throws(
  () => resolveAllowedPath("../outside", join(home, "personal"), [join(home, "personal")]),
  /Path is outside allowed roots/,
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}
