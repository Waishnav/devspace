import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-workspace-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const repository = join(root, "repository");
const nested = join(repository, "packages", "app");
const plainDirectory = join(root, "plain");
mkdirSync(nested, { recursive: true });
mkdirSync(plainDirectory);
execFileSync("git", ["init", "--quiet", repository]);
// Git returns canonical paths, while macOS and Windows temp directories may
// be reported through aliases such as /var or an 8.3 short path.
const allowedRoot = realpathSync.native(root);
const repositoryRoot = realpathSync.native(repository);
const nestedRoot = realpathSync.native(nested);
const plainRoot = realpathSync.native(plainDirectory);

test("a cwd inside a Git repository resolves to the repository root", () => {
  assert.deepEqual(resolveCliWorkspaceContext([plainRoot], {}, nestedRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(repositoryRoot),
  });
});

test("a cwd outside any Git repository resolves to the cwd", () => {
  assert.deepEqual(resolveCliWorkspaceContext([repositoryRoot], {}, plainRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(plainRoot),
  });
});

test("an injected workspace root without a workspace id is ignored", () => {
  assert.deepEqual(resolveCliWorkspaceContext([plainRoot], {
    DEVSPACE_WORKSPACE_ROOT: plainRoot,
  }, nestedRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(repositoryRoot),
  });
});

test("an injected workspace inside an allowed root is used", () => {
  assert.deepEqual(resolveCliWorkspaceContext([allowedRoot], {
    DEVSPACE_WORKSPACE_ID: "ws_injected",
    DEVSPACE_WORKSPACE_ROOT: nestedRoot,
  }, plainRoot), {
    workspaceId: "ws_injected",
    workspaceRoot: resolve(nestedRoot),
  });
});

test("a managed workspace outside allowed roots is used once authorized", () => {
  let managedChecks = 0;
  assert.deepEqual(resolveCliWorkspaceContext([repositoryRoot], {
    DEVSPACE_WORKSPACE_ID: "ws_managed",
    DEVSPACE_WORKSPACE_ROOT: plainRoot,
  }, nestedRoot, (workspaceRoot, workspaceId) => {
    managedChecks += 1;
    return workspaceId === "ws_managed" && workspaceRoot === plainRoot;
  }), {
    workspaceId: "ws_managed",
    workspaceRoot: plainRoot,
  });
  assert.equal(managedChecks, 1);
});

test("managed authorization is not consulted without a workspace id", () => {
  resolveCliWorkspaceContext([repositoryRoot], {
    DEVSPACE_WORKSPACE_ROOT: plainRoot,
  }, nestedRoot, () => {
    throw new Error("managed authorization must require an explicit workspace id");
  });
});

test("an unauthorized managed workspace outside allowed roots is rejected", () => {
  assert.throws(
    () => resolveCliWorkspaceContext([repositoryRoot], {
      DEVSPACE_WORKSPACE_ID: "ws_wrong",
      DEVSPACE_WORKSPACE_ROOT: plainRoot,
    }, nestedRoot, () => false),
    /outside allowed roots/,
  );
});

test("an injected workspace is contained by a symlinked allowed root", { skip: process.platform === "win32" }, () => {
  const repositoryAlias = join(root, "repository-alias");
  symlinkSync(repositoryRoot, repositoryAlias, "dir");
  assert.deepEqual(resolveCliWorkspaceContext([repositoryAlias], {
    DEVSPACE_WORKSPACE_ID: "ws_injected",
    DEVSPACE_WORKSPACE_ROOT: repositoryRoot,
  }, plainRoot), {
    workspaceId: "ws_injected",
    workspaceRoot: resolve(repositoryRoot),
  });
});

test("an injected workspace outside allowed roots is rejected", () => {
  assert.throws(
    () => resolveCliWorkspaceContext([repositoryRoot], {
      DEVSPACE_WORKSPACE_ID: "ws_injected",
      DEVSPACE_WORKSPACE_ROOT: plainRoot,
    }, nestedRoot),
    /outside allowed roots/,
  );
});
