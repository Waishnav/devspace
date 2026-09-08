import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { parse, type ParseError } from "jsonc-parser";
import { migrateLegacyConfig } from "../src/config-migration.js";
import { devspaceConfigSchema, type DevspaceConfig } from "../src/config-schema.js";
import { databasePath } from "../src/db/client.js";
import { expandHomePath } from "../src/roots.js";

const checkoutRoot = resolve(process.cwd());
const devRoot = join(checkoutRoot, ".devspace-dev");

export async function seedDevState({ reset = false }: { reset?: boolean } = {}): Promise<void> {
  const sourceConfigDir = resolve(
    expandHomePath(process.env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")),
  );
  if (isWithin(devRoot, sourceConfigDir)) {
    throw new Error("Refusing to seed development state from this checkout's own .devspace-dev directory.");
  }

  const source = await readSourceConfig(sourceConfigDir);
  const sourceStateDir = resolve(expandHomePath(source.config.storage.stateDir));
  const sourceDatabasePath = databasePath(sourceStateDir);

  if (existsSync(devRoot) && !reset) {
    throw new Error("Development state is already initialized. Run `pnpm dev:reset` to replace it.");
  }

  const stagingRoot = `${devRoot}.staging-${process.pid}-${Date.now()}`;
  const stagingConfigDir = join(stagingRoot, "config");
  const stagingStateDir = join(stagingRoot, "state");
  const devConfigDir = join(devRoot, "config");
  const devStateDir = join(devRoot, "state");

  try {
    await mkdir(stagingConfigDir, { recursive: true });
    await mkdir(stagingStateDir, { recursive: true });

    const localConfig: DevspaceConfig = {
      ...source.config,
      storage: {
        ...source.config.storage,
        stateDir: devStateDir,
      },
    };
    const localConfigPath = join(stagingConfigDir, "config.jsonc");
    await writeFile(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`, { mode: 0o600 });

    const sourceAuthPath = join(sourceConfigDir, "auth.json");
    if (existsSync(sourceAuthPath)) {
      const localAuthPath = join(stagingConfigDir, "auth.json");
      await cp(sourceAuthPath, localAuthPath);
      await chmod(localAuthPath, 0o600);
    } else if (!process.env.DEVSPACE_OAUTH_OWNER_TOKEN) {
      throw new Error(`No auth.json found in ${sourceConfigDir}. Run DevSpace setup before seeding development state.`);
    }

    for (const directory of ["skills", "agents"] as const) {
      const sourceDirectory = join(sourceConfigDir, directory);
      if (existsSync(sourceDirectory)) {
        await cp(sourceDirectory, join(stagingConfigDir, directory), { recursive: true });
      }
    }

    if (existsSync(sourceDatabasePath)) {
      await backupDatabase(sourceDatabasePath, databasePath(stagingStateDir));
    }

    await promoteStagedState(stagingRoot, reset);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  console.log(`${reset ? "Reset" : "Seeded"} development state in ${devRoot}`);
}

async function promoteStagedState(stagingRoot: string, reset: boolean): Promise<void> {
  if (!reset || !existsSync(devRoot)) {
    await rename(stagingRoot, devRoot);
    return;
  }

  const previousRoot = `${devRoot}.previous-${process.pid}-${Date.now()}`;
  await rename(devRoot, previousRoot);
  try {
    await rename(stagingRoot, devRoot);
  } catch (error) {
    await rename(previousRoot, devRoot);
    throw error;
  }
  await rm(previousRoot, { recursive: true, force: true });
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent));
}

async function readSourceConfig(configDir: string): Promise<{ config: DevspaceConfig }> {
  const configPath = join(configDir, "config.jsonc");
  if (existsSync(configPath)) {
    const source = await readFile(configPath, "utf8");
    const errors: ParseError[] = [];
    const value = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(`Unable to parse ${configPath}.`);
    }
    return { config: devspaceConfigSchema.parse(value) };
  }

  const legacyPath = join(configDir, "config.json");
  if (existsSync(legacyPath)) {
    const value = JSON.parse(await readFile(legacyPath, "utf8")) as unknown;
    return { config: migrateLegacyConfig(value) };
  }

  throw new Error(`No DevSpace configuration found in ${configDir}. Run DevSpace setup before seeding development state.`);
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationPath);
    await chmod(destinationPath, 0o600);
  } finally {
    source.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "seed") {
    await seedDevState();
    return;
  }
  if (command === "reset") {
    await seedDevState({ reset: true });
    return;
  }
  throw new Error("Usage: dev-state <seed|reset>");
}

await main();
