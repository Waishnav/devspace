import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDatabase } from "./db/client.js";
import { loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

if (platform() !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-permissions-test-"));
  try {
    const stateDir = join(root, "state");
    const database = openDatabase(stateDir);
    database.sqlite.exec("CREATE TABLE permission_test (id INTEGER); INSERT INTO permission_test VALUES (1)");

    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
    assert.equal((await stat(databasePath(stateDir) + "-wal")).mode & 0o777, 0o600);
    assert.equal((await stat(databasePath(stateDir) + "-shm")).mode & 0o777, 0o600);
    database.close();

    const configDir = join(root, "config");
    await mkdir(configDir, { mode: 0o777 });
    const env = { DEVSPACE_CONFIG_DIR: configDir };
    const configPath = writeDevspaceConfig({ port: 7676 }, env);
    const authPath = writeDevspaceAuth({ ownerToken: "test-owner-token-that-is-long-enough" }, env);

    await chmod(configDir, 0o777);
    await chmod(configPath, 0o666);
    await chmod(authPath, 0o666);
    loadDevspaceFiles(env);

    assert.equal((await stat(configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);

    await chmod(configDir, 0o777);
    await chmod(configPath, 0o666);
    await chmod(authPath, 0o666);
    writeDevspaceConfig({ port: 8787 }, env);
    writeDevspaceAuth({ ownerToken: "updated-owner-token-that-is-long-enough" }, env);

    assert.equal((await stat(configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
