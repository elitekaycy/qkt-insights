import type { Database } from "better-sqlite3";

/** Days of operational history kept before the weekly prune. Trade events (the analytics source of
 * truth) and marks for still-open positions are exempt regardless of age. */
export const RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RetentionResult {
  /** logs rows removed (with their FTS mirror). */
  logs: number;
  /** non-`trade` events removed (with their FTS mirror). */
  events: number;
  /** position_valuations marks removed for positions no longer open. */
  valuations: number;
}

/** Delete operational history older than `retentionDays`, preserving everything the dashboards
 * replay from. This is the entire retention policy — there is no other cleanup path.
 *
 * What is pruned:
 *  - `logs` (+ its `logs_fts` mirror): debug/operational log lines, fully disposable.
 *  - `events` (+ `events_fts`): only NON-`trade` types (health checks, signal/latch heartbeats).
 *    `type='trade'` events are the source of truth for win rate, expectancy, the calendar and cost
 *    decomposition, so they are never pruned.
 *  - `position_valuations`: per-tick marks whose (instance, broker, ticket) is not in
 *    `positions_current` — i.e. the position has closed. Open positions keep their full mark history.
 *
 * Deletes run in one transaction. `now` is injectable so tests can pin the cutoff.
 * e.g. a health event at now-40d is removed; a trade event at now-40d and a mark for an
 * open ticket at now-40d both survive. */
export function pruneRetention(db: Database, now: number, retentionDays = RETENTION_DAYS): RetentionResult {
  const cutoff = now - retentionDays * DAY_MS;
  return db.transaction(() => {
    db.prepare("DELETE FROM logs_fts WHERE log_rowid IN (SELECT rowid FROM logs WHERE ts < ?)").run(cutoff);
    const logs = db.prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;

    db.prepare(
      "DELETE FROM events_fts WHERE event_rowid IN (SELECT rowid FROM events WHERE ts < ? AND type <> 'trade')",
    ).run(cutoff);
    const events = db.prepare("DELETE FROM events WHERE ts < ? AND type <> 'trade'").run(cutoff).changes;

    const valuations = db
      .prepare(
        `DELETE FROM position_valuations WHERE ts < ? AND (instance_id, broker, ticket) NOT IN
         (SELECT instance_id, broker, ticket FROM positions_current)`,
      )
      .run(cutoff).changes;

    return { logs, events, valuations };
  })();
}

export interface StaleStrategyResult {
  /** strategy registrations removed. */
  strategies: number;
  /** total per-strategy data rows removed across every table. */
  rows: number;
}

/** Per-strategy tables to purge when a strategy is retired. Only those actually present with an
 * `(instance_id, strategy_id)` shape are touched, so a schema change can't crash the sweep. */
const STRATEGY_SCOPED_TABLES = [
  "logs",
  "events",
  "deals",
  "trade_closes",
  "equity_snapshots",
  "position_valuations",
  "positions_current",
  "risk_events",
  "risk_snapshots",
] as const;

function hasStrategyScope(db: Database, table: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  return names.has("instance_id") && names.has("strategy_id");
}

/** Remove strategies that stopped reporting more than `retentionDays` ago, and ALL of their data.
 *
 * Swapping a book only changes what the daemon trades — insights keeps a permanent registration for
 * every strategy that ever reported, so the old children linger in the dashboard forever. A
 * still-deployed strategy re-emits lifecycle/trade/log events (each bumps `last_seen`), and the
 * daemon re-registers every deployed strategy on each restart/redeploy — far more often than the
 * window — so only genuinely removed strategies age out. Unlike [pruneRetention]'s row-level,
 * analytics-preserving cut, a departed strategy's history is no longer relevant, so this deletes
 * everything keyed to it (registration + deals/trades/events/logs/marks/risk rows + FTS mirrors).
 *
 * e.g. the 14 children of a book swapped out 31 days ago all disappear on the next sweep; the 5
 * strategies deployed today keep reporting, so their `last_seen` stays inside the window. */
export function pruneStaleStrategies(db: Database, now: number, retentionDays = RETENTION_DAYS): StaleStrategyResult {
  const cutoff = now - retentionDays * DAY_MS;
  const tables = STRATEGY_SCOPED_TABLES.filter((t) => hasStrategyScope(db, t));
  return db.transaction(() => {
    const stale = db
      .prepare("SELECT instance_id AS i, strategy_id AS s FROM strategies WHERE last_seen < ?")
      .all(cutoff) as { i: string; s: string }[];
    let rows = 0;
    for (const { i, s } of stale) {
      db.prepare(
        "DELETE FROM logs_fts WHERE log_rowid IN (SELECT rowid FROM logs WHERE instance_id=? AND strategy_id=?)",
      ).run(i, s);
      db.prepare(
        "DELETE FROM events_fts WHERE event_rowid IN (SELECT rowid FROM events WHERE instance_id=? AND strategy_id=?)",
      ).run(i, s);
      for (const t of tables) {
        rows += db.prepare(`DELETE FROM ${t} WHERE instance_id=? AND strategy_id=?`).run(i, s).changes;
      }
    }
    const strategies = db.prepare("DELETE FROM strategies WHERE last_seen < ?").run(cutoff).changes;
    return { strategies, rows };
  })();
}
