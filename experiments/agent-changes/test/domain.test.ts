import assert from "node:assert/strict";
import { test } from "node:test";
import { publicGitUrl, repoName, requirePrompt } from "../src/domain.js";

test("accepts only public GitHub repository URLs", () => {
  assert.equal(publicGitUrl("https://github.com/cloudflare/computer"), "https://github.com/cloudflare/computer");
  for (const source of ["http://github.com/a/b", "https://localhost/a/b", "https://127.0.0.1/x/y", "https://github.com@evil.dev/a/b", "https://github.com/a/b/other", "https://gitlab.com/a/b"]) {
    assert.throws(() => publicGitUrl(source));
  }
});

test("names and tasks are constrained", () => {
  assert.equal(repoName("abcd1234", "agent1"), "dsa-abcd1234-agent1");
  assert.equal(requirePrompt(" write tests "), "write tests");
  assert.throws(() => requirePrompt(" "));
  assert.throws(() => repoName(".."));
});
