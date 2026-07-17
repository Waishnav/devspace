import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";

const JOURNAL_MODE_RETRY_TIMEOUT_MS = 5_000;
const JOURNAL_MODE_RETRY_DELAY_MS = 25;
const journalModeRetrySignal = new Int32Array(new SharedArrayBuffer(4));

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
  chmodSync(stateDir, 0o700);
  const path = databasePath(stateDir);
  const sqlite = new Database(path);
  try {
    chmodSync(path, 0o600);
    sqlite.pragma("busy_timeout = 5000");
    enableWriteAheadLogging(sqlite);
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);

    return {
      sqlite,
      db: createDrizzleDatabase(sqlite),
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function enableWriteAheadLogging(sqlite: SqliteDatabase): void {
  const deadline = Date.now() + JOURNAL_MODE_RETRY_TIMEOUT_MS;
  while (true) {
    try {
      sqlite.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(journalModeRetrySignal, 0, 0, JOURNAL_MODE_RETRY_DELAY_MS);
    }
  }
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
