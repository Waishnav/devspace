#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(resolve(kitDir, "manifest.json"), "utf8"));
const args = process.argv.slice(2);
const repoArgIndex = args.indexOf("--repo");
const repoRoot = resolve(repoArgIndex >= 0 ? args[repoArgIndex + 1] ?? "" : process.cwd());
const kitRelativePrefix = "compatibility-kit/openai-model-compatibility-2026-07/";

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, message) {
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail ? `${message}\n${detail}` : message);
  }
}

const packagePath = resolve(repoRoot, "package.json");
let packageJson;
try {
  packageJson = JSON.parse(await readFile(packagePath, "utf8"));
} catch {
  throw new Error(`Could not read a package.json at ${repoRoot}`);
}

if (packageJson.name !== manifest.target.package) {
  throw new Error(`Expected ${manifest.target.package}, found ${packageJson.name ?? "unknown"}.`);
}
if (packageJson.version !== manifest.target.version) {
  throw new Error(
    `This bundle targets DevSpace ${manifest.target.version}; found ${packageJson.version ?? "unknown"}.`,
  );
}

const inside = run("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });
requireSuccess(inside, "The target directory is not a Git working tree.");

const status = run("git", ["status", "--porcelain=v1"], { capture: true });
requireSuccess(status, "Could not inspect the target working tree.");
const blockingChanges = status.stdout
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean)
  .filter((line) => !line.slice(3).startsWith(kitRelativePrefix));
if (blockingChanges.length > 0) {
  throw new Error(
    "Refusing to patch a dirty working tree. Commit, stash, or remove existing changes first.",
  );
}

for (const patch of manifest.patches) {
  const patchPath = resolve(kitDir, patch.path);
  const check = run("git", ["apply", "--check", "--whitespace=error-all", patchPath], {
    capture: true,
  });
  requireSuccess(check, `Patch preflight failed: ${patch.path}`);
}

const applied = [];
try {
  for (const patch of manifest.patches) {
    const patchPath = resolve(kitDir, patch.path);
    const apply = run("git", ["apply", "--whitespace=fix", patchPath], { capture: true });
    requireSuccess(apply, `Could not apply ${patch.path}`);
    applied.push(patchPath);
    console.log(`Applied ${patch.path}`);
  }
} catch (error) {
  for (const patchPath of applied.reverse()) {
    run("git", ["apply", "--reverse", patchPath], { capture: true });
  }
  throw error;
}

console.log("Compatibility patches applied. No commit, push, publish, or deploy was performed.");
console.log("Run verify.mjs, inspect git diff, and commit only after review.");
