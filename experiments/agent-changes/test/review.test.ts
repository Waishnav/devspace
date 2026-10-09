import assert from "node:assert/strict";
import { test } from "node:test";
import { overlappingFiles } from "../src/review.js";

test("overlap warnings do not mistake duplicated paths in one proposal for overlap", () => {
  assert.deepEqual(overlappingFiles([["a.ts", "a.ts", "b.ts"], ["b.ts", "c.ts"]]), ["b.ts"]);
  assert.deepEqual(overlappingFiles([["a.ts"], ["b.ts"]]), []);
});
