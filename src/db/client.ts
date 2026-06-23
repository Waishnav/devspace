import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SqliteDatabase = Database.Database;
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
  setPrivateMode(stateDir, 0o700);

  const filePath = databasePath(stateDir);
  const sqlite = new Database(filePath);
  setPrivateMode(filePath, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setPrivateMode(filePath + "-wal", 0o600);
  setPrivateMode(filePath + "-shm", 0o600);

  return {
    sqlite,
    db: createDrizzleDatabase(sqlite),
    close: () => sqlite.close(),
  };
}

function setPrivateMode(path: string, mode: number): void {
  if (process.platform !== "win32" && existsSync(path)) chmodSync(path, mode);
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
