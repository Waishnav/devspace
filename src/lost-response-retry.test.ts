import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeFileTool } from "./pi-tools.js";

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

test("stale retry after a lost mutation response fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-lost-response-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.txt");
  await writeFile(path, "before\n");
  const expectedBeforeHash = hash("before\n");

  // The local mutation succeeds, but the caller is assumed to lose this response.
  await writeFileTool(
    { path: "note.txt", content: "agent-change\n" },
    { cwd: root, root, expectedBeforeHash },
  );
  assert.equal(await readFile(path, "utf8"), "agent-change\n");

  // Another actor changes the file before the caller retries the uncertain operation.
  await writeFile(path, "newer-external-change\n");

  const retry = await writeFileTool(
    { path: "note.txt", content: "agent-change\n" },
    { cwd: root, root, expectedBeforeHash },
  );

  assert.equal(retry.isError, true);
  assert.match(
    retry.content[0]?.type === "text" ? retry.content[0].text : "",
    /File precondition failed/,
  );
  assert.equal(await readFile(path, "utf8"), "newer-external-change\n");
});
