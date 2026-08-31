import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool, readFileTool, writeFileTool } from "./pi-tools.js";

const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-pi-tools-test-"));
try {
  const workspace = join(fixtureRoot, "workspace");
  const outside = join(fixtureRoot, "outside");
  const inside = join(workspace, "inside");
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside secret\n");
  await writeFile(join(outside, "editable.txt"), "before\n");

  const outsideLink = join(workspace, "outside-link");
  await symlink(outside, outsideLink, process.platform === "win32" ? "junction" : "dir");
  const context = { cwd: workspace, root: workspace };

  await assert.rejects(
    readFileTool({ path: "outside-link/secret.txt" }, context),
    /outside allowed roots/,
  );
  await assert.rejects(
    writeFileTool({ path: "outside-link/new.txt", content: "escaped\n" }, context),
    /outside allowed roots/,
  );
  await assert.rejects(readFile(join(outside, "new.txt"), "utf8"), /ENOENT/);

  await assert.rejects(
    editFileTool(
      {
        path: "outside-link/editable.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
      context,
    ),
    /outside allowed roots/,
  );
  assert.equal(await readFile(join(outside, "editable.txt"), "utf8"), "before\n");

  const insideLink = join(workspace, "inside-link");
  await symlink(inside, insideLink, process.platform === "win32" ? "junction" : "dir");
  const safeWrite = await writeFileTool(
    { path: "inside-link/new.txt", content: "inside\n" },
    context,
  );
  assert.equal(safeWrite.isError, undefined);
  assert.equal(await readFile(join(inside, "new.txt"), "utf8"), "inside\n");

  if (process.platform !== "win32") {
    const danglingLink = join(workspace, "dangling-link");
    const danglingTarget = join(outside, "dangling-created.txt");
    await symlink(danglingTarget, danglingLink);
    await assert.rejects(
      writeFileTool({ path: "dangling-link", content: "escaped\n" }, context),
      /Cannot resolve symbolic link/,
    );
    await assert.rejects(readFile(danglingTarget, "utf8"), /ENOENT/);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
