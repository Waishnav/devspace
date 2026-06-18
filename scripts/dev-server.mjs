import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const watchRoots = ["src"].map((entry) => join(repoRoot, entry));
const restartDelayMs = 750;
const crashDelayMs = 1500;

let child;
let restartTimer;
let stoppingForRestart = false;
let shuttingDown = false;

function log(message) {
  console.error(`[devspace:dev] ${message}`);
}

export function createServerCommand() {
  return {
    command: process.execPath,
    args: [tsxCliPath, "src/cli.ts", "serve"],
  };
}

function start() {
  stoppingForRestart = false;
  const { command, args } = createServerCommand();
  child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (stoppingForRestart) return;

    log(`server exited (${signal ?? code ?? "unknown"}); restarting in ${crashDelayMs}ms`);
    scheduleRestart(crashDelayMs);
  });
}

function scheduleRestart(delayMs = restartDelayMs) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, delayMs);
}

function restart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);

  if (!child) {
    start();
    return;
  }

  stoppingForRestart = true;
  child.once("exit", () => {
    if (!shuttingDown) start();
  });
  child.kill("SIGTERM");

  setTimeout(() => {
    if (child && stoppingForRestart) child.kill("SIGKILL");
  }, 3000).unref();
}

function watchDirectory(root) {
  const watchers = [];
  const seen = new Set();

  function addDirectory(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);

    const watcher = watch(dir, (event, filename) => {
      if (!filename) {
        scheduleRestart();
        return;
      }

      const path = join(dir, filename.toString());
      if (event === "rename") maybeAddDirectory(path);
      scheduleRestart();
    });
    watchers.push(watcher);

    for (const entry of readdirSync(dir)) {
      maybeAddDirectory(join(dir, entry));
    }
  }

  function maybeAddDirectory(path) {
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
  return watchers;
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (!child) return process.exit(0);

  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
  setTimeout(() => process.exit(1), 3000).unref();
}

function main() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, shutdown);
  }

  for (const root of watchRoots) {
    watchDirectory(root);
  }

  log("watching src; server restarts on changes and after crashes");
  start();
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main();
}
