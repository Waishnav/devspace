import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const repoRoot = dirname(packageJsonPath);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  bin: { devspace: string };
};
// This verifies the compiled entrypoint declared for the installed `devspace`
// command. npm's package-install shim itself is outside this focused test.
const cliPath = join(repoRoot, packageJson.bin.devspace);
const tscPath = require.resolve("typescript/bin/tsc");

test("show-changes prints a Git-backed historical review", async (t) => {
  await execFileAsync(process.execPath, [tscPath, "-p", join(repoRoot, "tsconfig.build.json")], {
    cwd: repoRoot,
  });

  const root = await mkdtemp(join(tmpdir(), "devspace-cli-show-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await execFileAsync("git", ["init", project]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(project, "README.md"), "hello\n");
  await git(project, ["add", "README.md"]);
  await git(project, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_cli", root: project });
  await writeFile(join(project, "README.md"), "hello\nreview me\n");
  const review = await manager.reviewChanges({ workspaceId: "ws_cli", root: project });

  const configDir = join(root, ".devspace");
  const env = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [project] },
    storage: { stateDir: join(root, ".state") },
  });
  const cliArgs = [cliPath, "show-changes", review.reviewRef];
  const plain = await execFileAsync("node", cliArgs, {
    cwd: project,
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "",
      DEVSPACE_WORKSPACE_ROOT: "",
    },
    encoding: "utf8",
  });
  assert.match(plain.stdout, /\+review me/);

  const json = await execFileAsync("node", [...cliArgs, "--json"], {
    cwd: project,
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "",
      DEVSPACE_WORKSPACE_ROOT: "",
    },
    encoding: "utf8",
  });
  const parsed = JSON.parse(json.stdout) as {
    reviewRef: string;
    patch: string;
  };
  assert.equal(parsed.reviewRef, review.reviewRef);
  assert.equal(parsed.patch, review.patch);

  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  })).stdout.trim();
  await assert.rejects(
    execFileAsync("node", [cliPath, "show-changes", head], {
      cwd: project,
      env: {
        ...process.env,
        ...env,
        DEVSPACE_WORKSPACE_ID: "",
        DEVSPACE_WORKSPACE_ROOT: "",
      },
      encoding: "utf8",
    }),
    (error: unknown) => {
      assert.match(
        (error as { stderr?: string }).stderr ?? "",
        /Unknown DevSpace review reference/,
      );
      return true;
    },
  );
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
