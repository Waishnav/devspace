import { backup, DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export function openSqlite(path: string, options: DatabaseSyncOptions = {}): SqliteDatabase {
  return new DatabaseSync(path, options);
}

/** Copies a live database to `path` using SQLite's online backup API. */
export async function backupSqlite(source: SqliteDatabase, path: string): Promise<void> {
  await backup(source, path);
}

let savepointCount = 0;

/** Runs `run` atomically; nested calls become savepoints so an inner failure rolls back only its own work. */
export function transaction<T>(
  database: SqliteDatabase,
  run: () => T,
  mode: "deferred" | "immediate" = "deferred",
): T {
  if (database.isTransaction) {
    const savepoint = `devspace_${++savepointCount}`;
    database.exec(`savepoint ${savepoint}`);

    try {
      const result = run();
      database.exec(`release ${savepoint}`);

      return result;
    } catch (error) {
      database.exec(`rollback to ${savepoint}`);
      database.exec(`release ${savepoint}`);
      throw error;
    }
  }

  database.exec(mode === "immediate" ? "begin immediate" : "begin");

  try {
    const result = run();
    database.exec("commit");

    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("rollback");
    throw error;
  }
}
