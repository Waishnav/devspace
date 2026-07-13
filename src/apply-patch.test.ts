import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, isSamePatchFile, parsePatch, replaceFile } from "./apply-patch.js";

const root = await mkdtemp(join(tmpdir(), "devspace-apply-patch-"));
const replacement = join(root, "replacement.txt");
const replacementTemporary = join(root, "replacement.tmp");
await writeFile(replacement, "old\n");
await writeFile(replacementTemporary, "new\n");
await replaceFile(replacementTemporary, replacement, true, "win32");
assert.equal(await readFile(replacement, "utf8"), "new\n");

const sameIdentity = async (): Promise<{ dev: number; ino: number }> => ({ dev: 1, ino: 2 });
const differentIdentity = async (path: string): Promise<{ dev: number; ino: number }> => ({
  dev: 1,
  ino: path.endsWith("foo.txt") ? 3 : 2,
});
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/Foo.txt"), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", sameIdentity), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/bar.txt", sameIdentity), false);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", differentIdentity), false);

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
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

const splitHunkRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-split-hunk-"));
await writeFile(
  join(splitHunkRoot, "long.txt"),
  Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n") + "\n",
);
const splitHunkResult = await applyPatch(
  splitHunkRoot,
  `*** Begin Patch
*** Update File: long.txt
@@
 1
-2
+two
 3
@@
 17
-18
+eighteen
 19
*** End Patch`,
);
assert.equal(splitHunkResult.patch.match(/^@@ /gm)?.length, 2);
assert.equal(
  await readFile(join(splitHunkRoot, "long.txt"), "utf8"),
  [
    "1", "two", "3", "4", "5", "6", "7", "8", "9", "10",
    "11", "12", "13", "14", "15", "16", "17", "eighteen", "19", "20",
  ].join("\n") + "\n",
);

const trailingSpaceRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-trailing-space-"));
await writeFile(join(trailingSpaceRoot, "spaces.txt"), "old\n");
const trailingSpaceResult = await applyPatch(
  trailingSpaceRoot,
  `*** Begin Patch
*** Update File: spaces.txt
@@
-old
+new${"   "}
*** End Patch`,
);
assert.equal(trailingSpaceResult.patch.endsWith("+new   "), true);
assert.equal(await readFile(join(trailingSpaceRoot, "spaces.txt"), "utf8"), "new   \n");

assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /contains no file actions/);
assert.throws(() => parsePatch("*** Add File: bad.txt\n+x"), /missing .* marker/);
assert.throws(
  () => parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch"),
  /has no content/,
);

const overwriteRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-overwrite-"));
await writeFile(join(overwriteRoot, "duplicate.txt"), "old content\n");
await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** End Patch`,
);
assert.equal(await readFile(join(overwriteRoot, "duplicate.txt"), "utf8"), "new content\n");

await writeFile(join(overwriteRoot, "source.txt"), "from\n");
await writeFile(join(overwriteRoot, "destination.txt"), "existing\n");
await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-from
+new
*** End Patch`,
);
assert.equal(await readFile(join(overwriteRoot, "destination.txt"), "utf8"), "new\n");
await assert.rejects(readFile(join(overwriteRoot, "source.txt"), "utf8"), /ENOENT/);

const noNewlineRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-newline-"));
await writeFile(join(noNewlineRoot, "no-newline.txt"), "old");
await applyPatch(
  noNewlineRoot,
  `*** Begin Patch
*** Update File: no-newline.txt
@@
-old
+new
*** End Patch`,
);
assert.equal(await readFile(join(noNewlineRoot, "no-newline.txt"), "utf8"), "new\n");

const eofRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-eof-"));
await writeFile(join(eofRoot, "tail.txt"), "first\nsecond\n");
await applyPatch(
  eofRoot,
  `*** Begin Patch
*** Update File: tail.txt
@@
 first
-second
+second updated
*** End of File
*** End Patch`,
);
assert.equal(await readFile(join(eofRoot, "tail.txt"), "utf8"), "first\nsecond updated\n");
await assert.rejects(
  applyPatch(
    eofRoot,
    `*** Begin Patch
*** Update File: tail.txt
@@
 first
+not tail
*** End of File
*** End Patch`,
  ),
  /could not find hunk context/,
);

const lenientRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-lenient-"));
await writeFile(join(lenientRoot, "file.txt"), "one\n");
await applyPatch(
  lenientRoot,
  `<<'EOF'
 *** Begin Patch
  *** Update File: file.txt
@@
-one
+two
 *** End Patch
EOF`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\n");

await applyPatch(
  lenientRoot,
  `*** Begin Patch
*** Environment ID: ignored
*** Update File: file.txt
 two
+three
*** End Patch`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\nthree\n");

await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Add File: ${join(lenientRoot, "absolute.txt")}
+no
*** End Patch`,
  ),
  /path must be relative/,
);

await writeFile(join(lenientRoot, "binary.dat"), Buffer.from([0, 159, 146, 150]));
await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Update File: binary.dat
@@
-x
+y
*** End Patch`,
  ),
  /not valid UTF-8|binary/,
);
