import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const requiredPackageFiles = [
  "dist/cli.js",
  "dist/server.js",
  "dist/local-agent-daemon-main.js",
  "dist/db/migrations.js",
  "dist/ui/workspace-app.html",
  "scripts/fix-node-pty-permissions.mjs",
  "skills/subagents/SKILL.md",
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "devspace-package-test-"));

try {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const packed = await runNpm(["pack", "--json", "--pack-destination", temporaryRoot], repositoryRoot);
  const [packageResult] = JSON.parse(packed.stdout);
  const packedPaths = new Set(packageResult.files.map(({ path }) => path));

  for (const requiredPath of requiredPackageFiles) {
    assert.ok(packedPaths.has(requiredPath), `${requiredPath} is missing from the npm package`);
  }

  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({ name: "devspace-package-consumer", private: true }, null, 2),
  );

  const tarballPath = join(temporaryRoot, packageResult.filename);
  await runNpm(["install", "--no-audit", "--no-fund", tarballPath], consumerRoot);

  const executable = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "devspace.cmd" : "devspace",
  );
  const version = await run(executable, ["--version"], consumerRoot);
  assert.equal(version.stdout.trim(), packageJson.version);

  await run(executable, ["doctor"], consumerRoot, {
    ...process.env,
    DEVSPACE_ALLOWED_ROOTS: consumerRoot,
    DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "package-test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  });

  console.log(`Installed and exercised ${packageResult.filename} as a consumer.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  return run(npmExecutable, args, cwd);
}

function run(file, args, cwd, env = process.env) {
  return execFileAsync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}
