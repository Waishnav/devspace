import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { openSqlite } from "./db/sqlite.js";

const root = await mkdtemp(join(tmpdir(), "devspace-dev-state-test-"));
const checkoutRoot = join(root, "checkout");
const sourceConfigDir = join(root, "config");
const sourceStateDir = join(root, "state");
const scriptPath = fileURLToPath(new URL("../scripts/dev-state.ts", import.meta.url));
const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));

after(() => rm(root, { recursive: true, force: true }));

test("seed copies source config and state, and reset reseeds only once source auth is valid", async () => {
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

  const sourceDatabase = openSqlite(join(sourceStateDir, "devspace.sqlite"));
  sourceDatabase.exec("create table marker (value text); insert into marker values ('source')");
  sourceDatabase.close();

  await runDevState("seed");

  const devRoot = join(checkoutRoot, ".devspace-dev");

  // SAFETY: The surrounding checks or construction already match this type.
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
  const localDatabase = openSqlite(localDatabasePath);
  assert.equal(localDatabase.prepare("select value from marker").get()?.value, "source");
  localDatabase.exec("insert into marker values ('local-only')");
  localDatabase.close();

  await assert.rejects(runDevState("seed"), /already initialized/);

  await rm(join(sourceConfigDir, "auth.json"));
  await assert.rejects(runDevState("reset"), /No auth\.json found/);

  const preservedDatabase = openSqlite(localDatabasePath, { readOnly: true });

  try {
    assert.deepEqual(
      preservedDatabase.prepare("select value from marker order by rowid").all().map((row) => row.value),
      ["source", "local-only"],
    );
  } finally {
    preservedDatabase.close();
  }

  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await runDevState("reset");

  const resetDatabase = openSqlite(localDatabasePath, { readOnly: true });
  assert.deepEqual(resetDatabase.prepare("select value from marker order by rowid").all().map((row) => row.value), ["source"]);
  resetDatabase.close();
});

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
