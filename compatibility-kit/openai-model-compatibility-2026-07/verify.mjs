#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const repoArgIndex = args.indexOf("--repo");
const repoRoot = resolve(repoArgIndex >= 0 ? args[repoArgIndex + 1] ?? "" : process.cwd());
const skipInstall = args.includes("--skip-install");

function run(command, commandArgs, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(detail || `${command} ${commandArgs.join(" ")} failed.`);
  }
  return result.stdout ?? "";
}

const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
if (packageJson.name !== "@waishnav/devspace") {
  throw new Error("Verification must run in a DevSpace repository checkout.");
}

const changed = run(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMRT", "HEAD"],
  true,
)
  .split("\n")
  .filter(Boolean);
const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], true)
  .split("\n")
  .filter(Boolean);
const candidateFiles = [...new Set([...changed, ...untracked])];
const forbiddenMarkers = [
  "/Users/",
  "/home/",
  "BEGIN OPENSSH PRIVATE KEY",
  "gho_",
  "sk-proj-",
  "private-user-images.githubusercontent.com",
];

for (const relativePath of candidateFiles) {
  let content;
  try {
    content = await readFile(resolve(repoRoot, relativePath), "utf8");
  } catch {
    continue;
  }
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) {
      throw new Error(`Public-data check failed in ${relativePath}: forbidden marker detected.`);
    }
  }
}

if (!skipInstall) run("npm", ["ci"]);
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["run", "build"]);

console.log("Verification passed: privacy markers, typecheck, tests, and build are clean.");
