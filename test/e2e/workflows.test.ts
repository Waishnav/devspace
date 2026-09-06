import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture, git } from "./fixture.js";
import { exec, installPackage } from "./package.js";

let installed: Awaited<ReturnType<typeof installPackage>>;
before(async () => { installed = await installPackage(); }, { timeout: 720_000 });
after(async () => { await installed?.close(); });

function data(result: CallToolResult) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function text(result: CallToolResult) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function id(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.ok(value);
  return value as string;
}

function reviewPatch(result: CallToolResult) {
  data(result);
  const card = result._meta?.card as { payload?: { patch?: string } } | undefined;
  return id(card?.payload?.patch);
}

const patchGreeting = "*** Begin Patch\n*** Update File: README.md\n@@\n-hello\n+goodbye\n*** End Patch";

for (const protocol of ["legacy", "modern"] as const) {
  test(`${protocol}: edit, execute, review and restore through the installed server`, { timeout: 60_000 }, async (t) => {
    const app = await fixture(t, installed.directory);
    let session = await app.session(protocol);
    const meta = { "openai/session": `e2e-${protocol}` };
    const opened = data(await session.call("open_workspace", { path: app.project }, meta));
    const workspaceId = id(opened.workspaceId);
    assert.match(JSON.stringify(opened.agentsFiles), /Keep the project greeting concise/);
    const read = await session.call("read", { workspaceId, path: "README.md" });
    assert.notEqual(read.isError, true);
    assert.match(text(read), /hello/);
    data(await session.call("apply_patch", { workspaceId, patch: patchGreeting }));
    assert.equal(await readFile(join(app.project, "README.md"), "utf8"), "goodbye\n");
    const command = data(await session.call("exec_command", {
      workspaceId, cmd: "git diff -- README.md", yieldTimeMs: 10_000,
    }));
    assert.equal(command.exitCode, 0);
    assert.match(id(command.result), /-hello\n\+goodbye/);
    const reviewed = await session.call("show_changes", { workspaceId });
    const reviewRef = id(data(reviewed).reviewRef);
    const patch = reviewPatch(reviewed);
    assert.match(patch, /-hello\n\+goodbye/);

    await app.restart();
    session = await app.session(protocol); // Uses the original persisted access token.
    const restored = data(await session.call("open_workspace", { path: app.project }, meta));
    assert.equal(restored.workspaceId, workspaceId);
    const historical = await session.call("show_changes", { workspaceId }, { "devspace/reviewRef": reviewRef });
    assert.equal(reviewPatch(historical), patch);
    const clean = await session.call("show_changes", { workspaceId });
    assert.equal((clean._meta?.card as { summary?: { files?: number } })?.summary?.files, 0);
  });
}

test("failed patches and outside paths preserve existing files", { timeout: 45_000 }, async (t) => {
  const app = await fixture(t, installed.directory);
  const session = await app.session("modern");
  const workspaceId = id(data(await session.call("open_workspace", { path: app.project })).workspaceId);
  const outside = join(app.root, "outside.txt");
  await writeFile(outside, "untouched\n");
  const invalid = await session.call("apply_patch", { workspaceId,
    patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-hello\n+changed\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch" });
  assert.equal(invalid.isError, true, text(invalid));
  assert.equal(await readFile(join(app.project, "README.md"), "utf8"), "hello\n");
  const denied = await session.call("read", { workspaceId, path: "../outside.txt" });
  assert.equal(denied.isError, true, text(denied));
  const escape = await session.call("apply_patch", { workspaceId,
    patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+overwrite\n*** End Patch" });
  assert.equal(escape.isError, true, text(escape));
  const outsideDirectory = join(app.root, "outside");
  await mkdir(outsideDirectory);
  await symlink(outsideDirectory, join(app.project, "link"), process.platform === "win32" ? "junction" : "dir");
  const linked = await session.call("apply_patch", { workspaceId,
    patch: "*** Begin Patch\n*** Add File: link/escaped.txt\n+overwrite\n*** End Patch" });
  assert.equal(linked.isError, true, text(linked));
  await assert.rejects(readFile(join(outsideDirectory, "escaped.txt")), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "untouched\n");
});

test("worktree edits leave the source checkout untouched", { timeout: 45_000 }, async (t) => {
  const app = await fixture(t, installed.directory);
  const sourceHead = await git(app.project, "rev-parse", "HEAD");
  const session = await app.session("legacy");
  const opened = data(await session.call("open_workspace", { path: app.project, mode: "worktree" }));
  assert.equal(opened.mode, "worktree");
  const workspaceId = id(opened.workspaceId);
  const worktree = id(opened.root);
  assert.notEqual(worktree, app.project);
  data(await session.call("apply_patch", { workspaceId, patch: patchGreeting }));
  assert.equal(await readFile(join(worktree, "README.md"), "utf8"), "goodbye\n");
  assert.equal(await readFile(join(app.project, "README.md"), "utf8"), "hello\n");
  assert.equal(await git(app.project, "status", "--porcelain"), "");
  assert.equal(await git(app.project, "rev-parse", "HEAD"), sourceHead);
  assert.match(reviewPatch(await session.call("show_changes", { workspaceId })), /\+goodbye/);
});

test("Claude tools write and edit through the installed surface", { timeout: 45_000 }, async (t) => {
  const app = await fixture(t, installed.directory, "claude");
  const client = await app.connect();
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("edit") && names.includes("write"));
  assert.equal(names.includes("apply_patch"), false);
  const session = await app.session("legacy");
  const workspaceId = id(data(await session.call("open_workspace", { path: app.project })).workspaceId);
  data(await session.call("write", { workspaceId, path: "note.txt", content: "first\n" }));
  data(await session.call("edit", { workspaceId, path: "note.txt", edits: [{ oldText: "first", newText: "second" }] }));
  assert.equal(await readFile(join(app.project, "note.txt"), "utf8"), "second\n");
  const refused = await session.call("write", { workspaceId, path: "../outside.txt", content: "bad" });
  assert.equal(refused.isError, true);
  await assert.rejects(readFile(join(app.root, "outside.txt")), { code: "ENOENT" });
});

test("process input and output stay with the owning workspace", { timeout: 45_000 }, async (t) => {
  const app = await fixture(t, installed.directory);
  const session = await app.session("modern");
  const workspaceId = id(data(await session.call("open_workspace", { path: app.project })).workspaceId);
  const other = id(data(await session.call("open_workspace", { path: app.project })).workspaceId);
  assert.notEqual(other, workspaceId);
  await writeFile(join(app.project, "interactive.cjs"),
    "process.stdin.once('data', data => { process.stdout.write('received:' + data.toString(), () => process.exit(0)); });\n");
  const started = data(await session.call("exec_command", { workspaceId, cmd: "node interactive.cjs", yieldTimeMs: 0 }));
  assert.equal(started.running, true);
  assert.equal(typeof started.sessionId, "number");
  const refused = await session.call("write_stdin", { workspaceId: other, sessionId: started.sessionId, chars: "wrong\n", yieldTimeMs: 0 });
  assert.equal(refused.isError, true);
  const finished = data(await session.call("write_stdin", { workspaceId, sessionId: started.sessionId, chars: "owner\n", yieldTimeMs: 10_000 }));
  assert.equal(finished.running, false, JSON.stringify(finished));
  assert.equal(finished.exitCode, 0);
  assert.match(id(finished.result), /received:owner/);
  assert.doesNotMatch(id(finished.result), /wrong/);
});

test("authentication rejects invalid tokens and refreshes a persisted grant", { timeout: 45_000 }, async (t) => {
  const app = await fixture(t, installed.directory);
  const rejected = await app.modern("tools/list", {}, "invalid-token");
  assert.equal(rejected.status, 401);
  const discovery = await app.modern("server/discover", {});
  assert.equal(discovery.status, 200);
  assert.match(await discovery.text(), /2026-07-28/);
  await app.restart();
  const refreshed = await fetch(`${app.baseUrl}/token`, {
    method: "POST", signal: AbortSignal.timeout(5_000),
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.tokens.client_id,
      refresh_token: app.tokens.refresh_token, resource: `${app.baseUrl}/mcp` }),
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const tokens = await refreshed.json() as { access_token: string };
  const client = await app.connect(id(tokens.access_token));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "open_workspace"));
  // Exercise npm's generated launchers, including the daemon's idle shutdown.
  const bin = (name: string) => join(installed.directory, "..", "..", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  const config = await exec(bin("devspace"), ["config", "get"], {
    cwd: app.root, env: app.env, encoding: "utf8", timeout: 10_000, shell: process.platform === "win32",
  });
  assert.equal(JSON.parse(config.stdout).tools.mode, "codex");
  await exec(bin("devspace-agentd"), [], {
    cwd: app.root, env: { ...app.env, DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "0", DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS: "1000" },
    timeout: 10_000, shell: process.platform === "win32",
  });
});
