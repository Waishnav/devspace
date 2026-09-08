import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = await mkdtemp(join(tmpdir(), "devspace-dev-state-test-"));
const checkoutRoot = join(root, "checkout");
const sourceConfigDir = join(root, "config");
const sourceStateDir = join(root, "state");
const scriptPath = fileURLToPath(new URL("../scripts/dev-state.ts", import.meta.url));
const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));

try {
  await mkdir(checkoutRoot, { recursive: true });
  await mkdir(join(sourceConfigDir, "skills", "example"), { recursive: true });
  await mkdir(sourceStateDir, { recursive: true });
  await writeFile(join(sourceConfigDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    storage: { stateDir: sourceStateDir },
  }));
  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await writeFile(join(sourceConfigDir, "skills", "example", "SKILL.md"), "example skill\n");

  const sourceDatabase = new Database(join(sourceStateDir, "devspace.sqlite"));
  sourceDatabase.exec("create table marker (value text); insert into marker values ('source')");
  sourceDatabase.close();

  await runDevState("seed");

  const devRoot = join(checkoutRoot, ".devspace-dev");
  const localConfig = JSON.parse(
    await readFile(join(devRoot, "config", "config.jsonc"), "utf8"),
  ) as { storage: { stateDir: string } };
  assert.equal(
    await realpath(localConfig.storage.stateDir),
    await realpath(join(devRoot, "state")),
  );
  assert.equal(existsSync(join(devRoot, "config", "auth.json")), true);
  assert.equal(existsSync(join(devRoot, "config", "skills", "example", "SKILL.md")), true);

  const localDatabasePath = join(devRoot, "state", "devspace.sqlite");
  const localDatabase = new Database(localDatabasePath);
  assert.equal(localDatabase.prepare("select value from marker").pluck().get(), "source");
  localDatabase.exec("insert into marker values ('local-only')");
  localDatabase.close();

  await assert.rejects(runDevState("seed"), /already initialized/);

  await rm(join(sourceConfigDir, "auth.json"));
  await assert.rejects(runDevState("reset"), /No auth\.json found/);

  const preservedDatabase = new Database(localDatabasePath, { readonly: true });
  try {
    assert.deepEqual(
      preservedDatabase.prepare("select value from marker order by rowid").pluck().all(),
      ["source", "local-only"],
    );
  } finally {
    preservedDatabase.close();
  }

  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await runDevState("reset");

  const resetDatabase = new Database(localDatabasePath, { readonly: true });
  assert.deepEqual(resetDatabase.prepare("select value from marker order by rowid").pluck().all(), ["source"]);
  resetDatabase.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("dev state tests passed");

async function runDevState(command: "seed" | "reset"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCliPath, scriptPath, command],
      {
        cwd: checkoutRoot,
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: sourceConfigDir,
          DEVSPACE_OAUTH_OWNER_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `dev-state exited with ${code}`));
    });
  });
}
