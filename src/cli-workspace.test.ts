import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-workspace-test-"));
try {
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

  assert.deepEqual(resolveCliWorkspaceContext([plainRoot], {}, nestedRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(repositoryRoot),
  });

  assert.deepEqual(resolveCliWorkspaceContext([repositoryRoot], {}, plainRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(plainRoot),
  });

  assert.deepEqual(resolveCliWorkspaceContext([plainRoot], {
    DEVSPACE_WORKSPACE_ROOT: plainRoot,
  }, nestedRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(repositoryRoot),
  });

  assert.deepEqual(resolveCliWorkspaceContext([allowedRoot], {
    DEVSPACE_WORKSPACE_ID: "ws_injected",
    DEVSPACE_WORKSPACE_ROOT: nestedRoot,
  }, plainRoot), {
    workspaceId: "ws_injected",
    workspaceRoot: resolve(nestedRoot),
  });

  if (process.platform !== "win32") {
    const repositoryAlias = join(root, "repository-alias");
    symlinkSync(repositoryRoot, repositoryAlias, "dir");
    assert.deepEqual(resolveCliWorkspaceContext([repositoryAlias], {
      DEVSPACE_WORKSPACE_ID: "ws_injected",
      DEVSPACE_WORKSPACE_ROOT: repositoryRoot,
    }, plainRoot), {
      workspaceId: "ws_injected",
      workspaceRoot: resolve(repositoryRoot),
    });
  }

  assert.throws(
    () => resolveCliWorkspaceContext([repositoryRoot], {
      DEVSPACE_WORKSPACE_ID: "ws_injected",
      DEVSPACE_WORKSPACE_ROOT: plainRoot,
    }, nestedRoot),
    /outside allowed roots/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
