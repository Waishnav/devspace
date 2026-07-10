import assert from "node:assert/strict";
import { delimiter } from "node:path";
import {
  commandWithAugmentedPath,
  resolveExecutable,
  shellPathInfo,
} from "./shell-environment.js";

const existing = ["/usr/bin", "/bin"].join(delimiter);
const existingDirs = new Set([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/test-home/.local/bin",
  "/usr/bin",
  "/bin",
]);
const info = shellPathInfo(
  { PATH: existing },
  "darwin",
  "/test-home",
  (path) => existingDirs.has(path),
);
assert.deepEqual(info.entries, [
  "/usr/bin",
  "/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/test-home/.local/bin",
]);
assert.deepEqual(info.addedEntries, [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/test-home/.local/bin",
]);
assert.match(commandWithAugmentedPath("gh auth status", { PATH: existing }, "darwin"), /^export PATH='/);
assert.equal(commandWithAugmentedPath("dir", { PATH: existing }, "win32"), "dir");
assert.equal(
  resolveExecutable(
    "gh",
    { PATH: existing },
    "darwin",
    (path) => path === "/opt/homebrew/bin/gh" || existingDirs.has(path),
  ),
  "/opt/homebrew/bin/gh",
);
assert.equal(resolveExecutable("bad command", { PATH: existing }, "darwin"), undefined);
