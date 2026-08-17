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
