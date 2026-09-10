import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editFileTool, writeFileTool } from "./pi-tools.js";

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

test("writeFileTool honors matching content-hash preconditions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-precondition-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.txt");
  await writeFile(path, "before\n");

  const response = await writeFileTool(
    { path: "note.txt", content: "after\n" },
    { cwd: root, root, expectedBeforeHash: hash("before\n") },
  );

  assert.equal(response.isError, undefined);
  assert.equal(await readFile(path, "utf8"), "after\n");
});

test("writeFileTool rejects stale and missing-file preconditions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-precondition-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "note.txt"), "current\n");

  const stale = await writeFileTool(
    { path: "note.txt", content: "overwrite\n" },
    { cwd: root, root, expectedBeforeHash: hash("old\n") },
  );
  assert.equal(stale.isError, true);
  assert.match(stale.content[0]?.type === "text" ? stale.content[0].text : "", /File precondition failed/);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "current\n");

  const create = await writeFileTool(
    { path: "new.txt", content: "created\n" },
    { cwd: root, root, expectedBeforeHash: "missing" },
  );
  assert.equal(create.isError, undefined);
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "created\n");

  const overwriteExisting = await writeFileTool(
    { path: "new.txt", content: "wrong\n" },
    { cwd: root, root, expectedBeforeHash: "missing" },
  );
  assert.equal(overwriteExisting.isError, true);
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "created\n");
});

test("editFileTool rejects an edit after the file diverges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-precondition-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.txt");
  await writeFile(path, "alpha\n");
  const expectedBeforeHash = hash("alpha\n");
  await writeFile(path, "beta\n");

  const response = await editFileTool(
    { path: "note.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
    { cwd: root, root, expectedBeforeHash },
  );

  assert.equal(response.isError, true);
  assert.equal(await readFile(path, "utf8"), "beta\n");
});

test("writeFileTool rejects an explicitly empty precondition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-precondition-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.txt");
  await writeFile(path, "current\n");

  const response = await writeFileTool(
    { path: "note.txt", content: "overwrite\n" },
    { cwd: root, root, expectedBeforeHash: "" },
  );

  assert.equal(response.isError, true);
  assert.equal(await readFile(path, "utf8"), "current\n");
});

test("writeFileTool serializes validation with concurrent mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-precondition-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.txt");
  await writeFile(path, "before\n");

  let signalChecked!: () => void;
  const checked = new Promise<void>((resolve) => {
    signalChecked = resolve;
  });
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = writeFileTool(
    { path: "note.txt", content: "first\n" },
    {
      cwd: root,
      root,
      expectedBeforeHash: hash("before\n"),
      afterPreconditionCheck: async () => {
        signalChecked();
        await holdFirst;
      },
    },
  );

  await checked;

  const second = writeFileTool(
    { path: "note.txt", content: "second\n" },
    { cwd: root, root, expectedBeforeHash: hash("before\n") },
  );

  releaseFirst();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.isError, undefined);
  assert.equal(secondResponse.isError, true);
  assert.equal(await readFile(path, "utf8"), "first\n");
});
