import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type Db = Database.Database;

/** WAL high-water mark SQLite may keep on disk after a checkpoint (64 MiB). */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // Without a size limit the WAL file never shrinks below its largest-ever size, even
  // once fully checkpointed; a single big replay batch leaves hundreds of MB behind.
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Fold the WAL back into the main file and truncate it. Safe to call while serving. */
export function checkpoint(db: Db): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}
