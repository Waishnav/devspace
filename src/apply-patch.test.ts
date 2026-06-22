import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, parsePatch, replaceFile } from "./apply-patch.js";

const root = await mkdtemp(join(tmpdir(), "devspace-apply-patch-"));
const replacement = join(root, "replacement.txt");
const replacementTemporary = join(root, "replacement.tmp");
await writeFile(replacement, "old\n");
await writeFile(replacementTemporary, "new\n");
await replaceFile(replacementTemporary, replacement, true, "win32");
assert.equal(await readFile(replacement, "utf8"), "new\n");
await writeFile(join(root, "alpha.txt"), "one\ntwo\nthree\n");
await writeFile(join(root, "remove.txt"), "remove me\n");
await writeFile(join(root, "windows.txt"), "first\r\nsecond\r\n");

const result = await applyPatch(
  root,
  `*** Begin Patch
*** Add File: nested/added.txt
+new
+file
*** Update File: alpha.txt
@@
 one
-two
+changed
 three
*** Update File: windows.txt
@@
 first
-second
+updated
*** Delete File: remove.txt
*** End Patch`,
);

assert.deepEqual(result.files, [
  { path: "nested/added.txt", operation: "add" },
  { path: "alpha.txt", operation: "update" },
  { path: "windows.txt", operation: "update" },
  { path: "remove.txt", operation: "delete" },
]);
assert.equal(result.additions, 4);
assert.equal(result.removals, 3);
assert.match(result.patch, /diff --git a\/alpha\.txt b\/alpha\.txt/);
assert.match(result.patch, /-two\n\+changed/);
assert.equal(await readFile(join(root, "nested/added.txt"), "utf8"), "new\nfile\n");
assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "one\nchanged\nthree\n");
assert.equal(await readFile(join(root, "windows.txt"), "utf8"), "first\r\nupdated\r\n");
await assert.rejects(readFile(join(root, "remove.txt"), "utf8"), /ENOENT/);

if (process.platform !== "win32") await chmod(join(root, "alpha.txt"), 0o755);
const moveResult = await applyPatch(
  root,
  `*** Begin Patch
*** Update File: alpha.txt
*** Move to: moved/alpha.txt
@@
-one
+ONE
 changed
*** End Patch`,
);
assert.deepEqual(moveResult.files, [
  { path: "moved/alpha.txt", previousPath: "alpha.txt", operation: "move" },
]);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");
if (process.platform !== "win32") {
  assert.notEqual((await stat(join(root, "moved/alpha.txt"))).mode & 0o111, 0);
}
await assert.rejects(readFile(join(root, "alpha.txt"), "utf8"), /ENOENT/);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`,
  ),
  /path escapes the workspace/,
);

const outside = await mkdtemp(join(tmpdir(), "devspace-apply-patch-outside-"));
await symlink(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: outside-link/escape.txt
+no
*** End Patch`,
  ),
  /path resolves outside the workspace/,
);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Update File: moved/alpha.txt
@@
-not present
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: should-not-exist.txt
+staged
*** Update File: moved/alpha.txt
@@
-missing context
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
await assert.rejects(readFile(join(root, "should-not-exist.txt"), "utf8"), /ENOENT/);

assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /contains no file actions/);
assert.throws(() => parsePatch("*** Add File: bad.txt\n+x"), /missing .* marker/);
