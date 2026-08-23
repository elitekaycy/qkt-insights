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

export interface RetentionPolicy {
  /** Days of per-poll position valuations to keep (excursion analytics read these). */
  valuationDays: number;
  /** Days of log lines to keep. */
  logDays: number;
  /** Days of market-data health events (`marketdata.*`) to keep. */
  marketDataEventDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { valuationDays: 30, logDays: 30, marketDataEventDays: 30 };

/**
 * Delete rows older than the policy. Trading evidence — orders, fills, trades, deals,
 * signals, risk events, strategy lifecycle — is never purged here; only the high-volume
 * telemetry that is re-observed every cycle.
 */
export function purgeExpired(db: Db, nowMs: number, policy: RetentionPolicy = DEFAULT_RETENTION): { valuations: number; logs: number; events: number } {
  const dayMs = 86_400_000;
  const run = db.transaction(() => {
    const valuations = db.prepare("DELETE FROM position_valuations WHERE ts < ?").run(nowMs - policy.valuationDays * dayMs).changes;
    const logCutoff = nowMs - policy.logDays * dayMs;
    db.prepare("DELETE FROM logs_fts WHERE log_rowid IN (SELECT rowid FROM logs WHERE ts < ?)").run(logCutoff);
    const logs = db.prepare("DELETE FROM logs WHERE ts < ?").run(logCutoff).changes;
    const eventCutoff = nowMs - policy.marketDataEventDays * dayMs;
    db.prepare("DELETE FROM events_fts WHERE event_rowid IN (SELECT rowid FROM events WHERE type LIKE 'marketdata.%' AND ts < ?)").run(eventCutoff);
    const events = db.prepare("DELETE FROM events WHERE type LIKE 'marketdata.%' AND ts < ?").run(eventCutoff).changes;
    return { valuations, logs, events };
  });
  return run();
}
