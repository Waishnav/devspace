import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrateDatabase } from "./migrations.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

export { transaction, type SqliteDatabase } from "./sqlite.js";

export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function databasePath(stateDir: string): string {
  return join(stateDir, "devspace.sqlite");
}

export function openDatabase(stateDir: string): DatabaseHandle {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = databasePath(stateDir);
  const sqlite = openSqlite(path);
  chmodSync(path, 0o600);
  sqlite.exec(`
    pragma journal_mode = WAL;
    pragma synchronous = NORMAL;
    pragma busy_timeout = 5000;
    pragma foreign_keys = ON;
  `);
  migrateDatabase(sqlite);

  return {
    sqlite,
    db: createDrizzleDatabase(sqlite),
    close: () => sqlite.close(),
  };
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle({ client: sqlite });
}
