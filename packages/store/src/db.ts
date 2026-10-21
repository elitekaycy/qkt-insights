import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { ensureProjections } from "./projections.js";

export type Db = Database.Database;

/** WAL high-water mark SQLite may keep on disk after a checkpoint (64 MiB). */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export function openDb(path: string): Db {
  const db = new Database(path);
  // A new database returns the pages deletes free (PRAGMA incremental_vacuum after each prune).
  // The mode is fixed once the first table exists, and setting WAL first fixes it too; an existing
  // database keeps its mode until an operator converts it (docs/operations/storage-maintenance.md).
  const empty = (db.prepare("SELECT COUNT(*) n FROM sqlite_master").get() as { n: number }).n === 0;
  if (empty) db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  // Without a size limit the WAL file never shrinks below its largest-ever size, even
  // once fully checkpointed; a single big replay batch leaves hundreds of MB behind.
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  ensureProjections(db);
  return db;
}

/**
 * Returns up to `pages` free pages to the filesystem and reports how many remain free. A no-op
 * (0) on a database without incremental auto-vacuum. Small steps keep each call short, so a
 * caller can return to the event loop between them.
 */
export function reclaimFreePages(db: Db, pages = 2000): number {
  if (db.pragma("auto_vacuum", { simple: true }) !== 2) return 0;
  db.pragma(`incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
  return db.pragma("freelist_count", { simple: true }) as number;
}

/** Fold the WAL back into the main file and truncate it. Safe to call while serving. */
export function checkpoint(db: Db): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}
