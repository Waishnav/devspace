import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AccessDeniedError,
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
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

const rejectedPath = resolve(home, "outside", "project");
const allowedRoots = [resolve(home, "personal"), resolve(home, "work")];
assert.throws(
  () => assertAllowedPath(rejectedPath, allowedRoots),
  (error: unknown) => {
    assert.ok(error instanceof AccessDeniedError);
    assert.equal(
      error.message,
      `Path is outside allowed roots: ${rejectedPath}\nAllowed roots:\n` +
        allowedRoots.map((root) => `- ${root}`).join("\n"),
    );
    return true;
  },
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}
