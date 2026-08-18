import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createReviewChangeJournal } from "./review-change-journal.js";

test("journal reports the net result of repeated successful edits", async (t) => {
  const root = await workspace(t);
  const path = join(root, "file.txt");
  await writeFile(path, "A\n");
  const journal = createReviewChangeJournal();

  const first = await journal.prepareMutation({ workspaceId: "ws_net", root, paths: [path] });
  await writeFile(path, "B\n");
  journal.commitMutation(first);

  const second = await journal.prepareMutation({ workspaceId: "ws_net", root, paths: [path] });
  await writeFile(path, "C\n");
  journal.commitMutation(second);

  const review = await journal.reviewChanges({ workspaceId: "ws_net", root });
  assert.deepEqual(review.files.map((file) => file.path), ["file.txt"]);
  assert.match(review.patch, /-A/);
  assert.match(review.patch, /\+C/);
  assert.doesNotMatch(review.patch, /[+-]B/);
});

test("journal drops net-zero mutations and unrelated filesystem changes", async (t) => {
  const root = await workspace(t);
  const tracked = join(root, "tracked.txt");
  const unrelated = join(root, "unrelated.txt");
  await writeFile(tracked, "A\n");
  await writeFile(unrelated, "before\n");
  const journal = createReviewChangeJournal();

  const mutation = await journal.prepareMutation({
    workspaceId: "ws_zero",
    root,
    paths: [tracked],
  });
  await writeFile(tracked, "B\n");
  await writeFile(tracked, "A\n");
  await writeFile(unrelated, "after\n");
  journal.commitMutation(mutation);

  const review = await journal.reviewChanges({ workspaceId: "ws_zero", root });
  assert.equal(review.summary.files, 0);
  assert.equal(review.patch, "");
});

test("journal preserves a move across later edits", async (t) => {
  const root = await workspace(t);
  const before = join(root, "before.txt");
  const after = join(root, "after.txt");
  await writeFile(before, "before\n");
  const journal = createReviewChangeJournal();

  const move = await journal.prepareMutation({
    workspaceId: "ws_move",
    root,
    paths: [before, after],
  });
  await rename(before, after);
  journal.commitMutation(move, [{ fromPath: "before.txt", toPath: "after.txt" }]);

  const edit = await journal.prepareMutation({ workspaceId: "ws_move", root, paths: [after] });
  await writeFile(after, "after\n");
  journal.commitMutation(edit);

  const review = await journal.reviewChanges({ workspaceId: "ws_move", root });
  assert.deepEqual(review.files, [
    {
      path: "after.txt",
      previousPath: "before.txt",
      type: "rename-changed",
      additions: 1,
      removals: 1,
    },
  ]);
});

test("markReviewed advances the journal without requiring Git", async (t) => {
  const root = await workspace(t);
  const path = join(root, "file.txt");
  await writeFile(path, "A\n");
  const journal = createReviewChangeJournal();
  const mutation = await journal.prepareMutation({ workspaceId: "ws_advance", root, paths: [path] });
  await writeFile(path, "B\n");
  journal.commitMutation(mutation);

  journal.markReviewed({ workspaceId: "ws_advance", root });
  assert.equal(journal.hasTrackedMutations("ws_advance"), false);
  const review = await journal.reviewChanges({ workspaceId: "ws_advance", root });
  assert.equal(review.summary.files, 0);
});

test("journal preserves empty-file additions as additions", async (t) => {
  const root = await workspace(t);
  const path = join(root, "empty.txt");
  const journal = createReviewChangeJournal();
  const mutation = await journal.prepareMutation({ workspaceId: "ws_empty", root, paths: [path] });
  await writeFile(path, "");
  journal.commitMutation(mutation);

  const review = await journal.reviewChanges({ workspaceId: "ws_empty", root });
  assert.equal(review.files[0]?.type, "new");
  assert.match(review.patch, /new file mode/);
});

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-journal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
