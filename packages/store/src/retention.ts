import type { Database } from "better-sqlite3";
import { VIEW_RETENTION_DAYS } from "./views.js";
import { bumpEpoch } from "./versions.js";

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
  /** monitor_minutes rollups and superseded monitor_events removed. */
  monitors: number;
  /** shared-link page views older than VIEW_RETENTION_DAYS removed. */
  views: number;
  /** quarantined envelopes received before the cutoff removed. */
  quarantined: number;
}

/** Delete operational history older than `retentionDays`, preserving everything the dashboards
 * replay from. This is the entire retention policy — there is no other cleanup path.
 *
 * What is pruned:
 *  - `logs` (+ its `logs_fts` mirror): debug/operational log lines, fully disposable.
 *  - `events` (+ `events_fts`): every NON-`trade` type, including order lifecycle, signals and
 *    lifecycle events, so /search and order-event history reach back only this far.
 *    `type='trade'` events are the source of truth for win rate, expectancy, the calendar and cost
 *    decomposition, so they are never pruned.
 *  - `position_valuations`: per-tick marks whose (instance, broker, ticket) is not in
 *    `positions_current` — i.e. the position has closed. Open positions keep their full mark history.
 *  - `monitor_minutes`, and `monitor_events` except each monitor's latest transition, which is
 *    what a restart restores the current status from.
 *  - `quarantined_events` by receive time: a contract that learns the type replays from what is left.
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

    const monitors =
      db.prepare("DELETE FROM monitor_minutes WHERE minute_ts < ?").run(cutoff).changes +
      db.prepare(
        `DELETE FROM monitor_events WHERE ts < ? AND ts < (SELECT MAX(ts) FROM monitor_events e WHERE e.monitor = monitor_events.monitor)`,
      ).run(cutoff).changes;

    // Views keep their own, longer window: audience trends are read over months.
    const views = db.prepare("DELETE FROM share_views WHERE ts < ?").run(now - VIEW_RETENTION_DAYS * DAY_MS).changes;

    const quarantined = db.prepare("DELETE FROM quarantined_events WHERE received_at < ?").run(cutoff).changes;

    bumpEpoch(db);
    return { logs, events, valuations, monitors, views, quarantined };
  })();
}

export interface StaleStrategyResult {
  /** strategies that stopped reporting past the window (now off the active roster). */
  strategies: number;
  /** operational rows removed across those strategies. */
  rows: number;
}

/** Operational per-strategy tables a retired strategy no longer needs. Money history (deals,
 * trade_closes, equity_snapshots, risk_events, trade events, open positions) is never listed. */
const RETIRED_OPERATIONAL_TABLES = ["logs", "risk_snapshots"] as const;

function hasStrategyScope(db: Database, table: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  return names.has("instance_id") && names.has("strategy_id");
}

/** Clear the operational history of strategies that stopped reporting more than `retentionDays` ago.
 *
 * Swapping a book only changes what the daemon trades; the swapped-out children keep their
 * registration. The roster marks a strategy inactive once its `last_seen` falls a window behind
 * the instance's newest strategy (listStrategies), which hides it from the active roster. Its money
 * history stays: deals, closed trades, equity snapshots, risk events, trade fills and open
 * positions are what "all-time" and the account totals are summed from, and deleting them made
 * all-time disagree with the venue. Only logs, non-trade events, risk snapshots and marks of
 * closed positions are removed.
 *
 * e.g. a book swapped out 31 days ago: its logs go, its deals and the registration that names
 * them stay, and the account's all-time net still includes them. */
export function pruneStaleStrategies(db: Database, now: number, retentionDays = RETENTION_DAYS): StaleStrategyResult {
  const cutoff = now - retentionDays * DAY_MS;
  const tables = RETIRED_OPERATIONAL_TABLES.filter((t) => hasStrategyScope(db, t));
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
        `DELETE FROM events_fts WHERE event_rowid IN
           (SELECT rowid FROM events WHERE instance_id=? AND strategy_id=? AND type NOT IN ('trade','trade.closed'))`,
      ).run(i, s);
      rows += db.prepare("DELETE FROM events WHERE instance_id=? AND strategy_id=? AND type NOT IN ('trade','trade.closed')").run(i, s).changes;
      for (const t of tables) {
        rows += db.prepare(`DELETE FROM ${t} WHERE instance_id=? AND strategy_id=?`).run(i, s).changes;
      }
      rows += db.prepare(
        `DELETE FROM position_valuations WHERE instance_id=? AND strategy_id=? AND (instance_id, broker, ticket) NOT IN
           (SELECT instance_id, broker, ticket FROM positions_current)`,
      ).run(i, s).changes;
    }
    if (rows > 0) bumpEpoch(db);
    return { strategies: stale.length, rows };
  })();
}
