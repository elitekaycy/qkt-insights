import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { addMoney, instanceMoneyDigits } from "./money.js";

/** Where a strategy's closes come from: broker deals (closed_trades) or the engine's trade.closed rows. */
export type CloseSource = "deal" | "ledger";

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** A strategy_daily dirty key: source, strategy and the first UTC day whose figures changed. */
export function dailyKey(source: CloseSource, strategyId: string, day: string): string {
  return `${source}\u0000${strategyId}\u0000${day}`;
}

export function parseDailyKey(key: string): { source: CloseSource; strategyId: string; day: string } {
  const [source, strategyId, day] = key.split("\u0000") as [CloseSource, string, string];
  return { source, strategyId, day };
}

const CLOSES_SINCE: Record<CloseSource, string> = {
  deal: "SELECT ts, realized, entry_ts entryTs FROM closed_trades WHERE instance_id=? AND strategy_id=? AND ts>=? ORDER BY ts ASC, deal_rowid ASC",
  ledger: "SELECT ts, realized, entry_ts entryTs FROM trade_closes WHERE instance_id=? AND strategy_id=? AND ts>=? ORDER BY ts ASC, rowid ASC",
};

const CLOSES_NEWEST_FIRST: Record<CloseSource, string> = {
  deal: "SELECT ts, realized, entry_ts entryTs FROM closed_trades WHERE instance_id=? AND strategy_id=? ORDER BY ts DESC, deal_rowid DESC",
  ledger: "SELECT ts, realized, entry_ts entryTs FROM trade_closes WHERE instance_id=? AND strategy_id=? ORDER BY ts DESC, rowid DESC",
};

/**
 * Rewrites one strategy's days from `sinceDay` on, and its totals. The day's net and the running
 * total are summed in close order, as the readers that build them from the closes do, at the
 * account currency's minor unit (addMoney), so a figure served from here is bit-for-bit the one a
 * rebuild from the closes gives. O(closes since the day)
 * for the days; the newest-first total re-adds every close, O(closes of the strategy).
 */
export function recomputeDaily(db: Db, instanceId: string, source: CloseSource, strategyId: string, sinceDay: string): void {
  const since = Date.parse(`${sinceDay}T00:00:00Z`);
  const prev = statement(db,
    "SELECT close_cum cum FROM strategy_daily WHERE instance_id=? AND strategy_id=? AND source=? AND day<? ORDER BY day DESC LIMIT 1",
  ).get(instanceId, strategyId, source, sinceDay) as { cum: number } | undefined;
  statement(db, "DELETE FROM strategy_daily WHERE instance_id=? AND strategy_id=? AND source=? AND day>=?").run(instanceId, strategyId, source, sinceDay);
  const closes = statement(db, CLOSES_SINCE[source]).all(instanceId, strategyId, Number.isFinite(since) ? since : Number.MIN_SAFE_INTEGER) as Array<{ ts: number; realized: number }>;
  const ins = statement(db,
    "INSERT INTO strategy_daily (instance_id, strategy_id, source, day, net, trades, close_cum, last_ts) VALUES (?,?,?,?,?,?,?,?)",
  );
  const digits = instanceMoneyDigits(db, instanceId);
  const add = (a: number, b: number) => addMoney(a, b, digits);
  let cum = prev?.cum ?? 0;
  let day: string | null = null, net = 0, trades = 0, lastTs = 0;
  for (const c of closes) {
    const d = utcDay(c.ts);
    if (d !== day) {
      if (day != null) ins.run(instanceId, strategyId, source, day, net, trades, cum, lastTs);
      day = d; net = 0; trades = 0;
    }
    net = add(net, c.realized);
    cum = add(cum, c.realized);
    trades++;
    lastTs = c.ts;
  }
  if (day != null) ins.run(instanceId, strategyId, source, day, net, trades, cum, lastTs);

  let total = 0, n = 0;
  let newest: { ts: number } | null = null, oldest: { ts: number; entryTs: number | null } | null = null;
  for (const c of statement(db, CLOSES_NEWEST_FIRST[source]).iterate(instanceId, strategyId) as IterableIterator<{ ts: number; realized: number; entryTs: number | null }>) {
    total = add(total, c.realized);
    n++;
    newest ??= c;
    oldest = c;
  }
  if (newest == null || oldest == null) {
    statement(db, "DELETE FROM strategy_totals WHERE instance_id=? AND strategy_id=? AND source=?").run(instanceId, strategyId, source);
    return;
  }
  statement(db,
    `INSERT INTO strategy_totals (instance_id, strategy_id, source, closes, net_newest_first, first_ts, first_entry_ts, last_ts)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(instance_id, strategy_id, source) DO UPDATE SET
       closes=excluded.closes, net_newest_first=excluded.net_newest_first, first_ts=excluded.first_ts,
       first_entry_ts=excluded.first_entry_ts, last_ts=excluded.last_ts`,
  ).run(instanceId, strategyId, source, n, total, oldest.ts, oldest.entryTs ?? null, newest.ts);
}

/** Folds queued daily keys: one recompute per strategy and source, from its earliest changed day. */
export function recomputeDailyKeys(db: Db, rows: Array<{ instanceId: string; key: string }>): void {
  const since = new Map<string, { instanceId: string; source: CloseSource; strategyId: string; day: string }>();
  for (const r of rows) {
    const k = parseDailyKey(r.key);
    const id = JSON.stringify([r.instanceId, k.source, k.strategyId]);
    const cur = since.get(id);
    if (!cur || k.day < cur.day) since.set(id, { instanceId: r.instanceId, ...k });
  }
  for (const u of since.values()) recomputeDaily(db, u.instanceId, u.source, u.strategyId, u.day);
}

/** Strategies with closes, per source, after `after` in (source, instance, strategy) order: rebuild units. */
export function dailyUnitsAfter(db: Db, after: { source: CloseSource; instanceId: string; strategyId: string } | null, limit: number): Array<{ source: CloseSource; instanceId: string; strategyId: string }> {
  const out: Array<{ source: CloseSource; instanceId: string; strategyId: string }> = [];
  const sql: Record<CloseSource, string> = {
    deal: `SELECT DISTINCT instance_id instanceId, strategy_id strategyId FROM closed_trades
           WHERE strategy_id IS NOT NULL AND (instance_id, strategy_id) > (?, ?) ORDER BY instance_id, strategy_id LIMIT ?`,
    ledger: `SELECT DISTINCT instance_id instanceId, strategy_id strategyId FROM trade_closes
             WHERE strategy_id IS NOT NULL AND (instance_id, strategy_id) > (?, ?) ORDER BY instance_id, strategy_id LIMIT ?`,
  };
  for (const source of ["deal", "ledger"] as const) {
    if (after && after.source === "ledger" && source === "deal") continue;
    const from = after && after.source === source ? [after.instanceId, after.strategyId] : ["", ""];
    const rows = statement(db, sql[source]).all(from[0], from[1], limit - out.length) as Array<{ instanceId: string; strategyId: string }>;
    for (const r of rows) out.push({ source, ...r });
    if (out.length === limit) break;
  }
  return out;
}

export function clearDaily(db: Db): void {
  statement(db, "DELETE FROM strategy_daily").run();
  statement(db, "DELETE FROM strategy_totals").run();
  statement(db, "DELETE FROM projection_dirty WHERE kind='daily'").run();
}

export interface DailyRow { day: string; net: number; trades: number; closeCum: number; lastTs: number }

/** One strategy's days for a source, oldest first. */
export function dailyRows(db: Db, instanceId: string, strategyId: string, source: CloseSource): DailyRow[] {
  return statement(db,
    "SELECT day, net, trades, close_cum closeCum, last_ts lastTs FROM strategy_daily WHERE instance_id=? AND strategy_id=? AND source=? ORDER BY day ASC",
  ).all(instanceId, strategyId, source) as DailyRow[];
}

export interface StrategyTotals { closes: number; netNewestFirst: number; firstTs: number; firstEntryTs: number | null; lastTs: number }

export function strategyTotals(db: Db, instanceId: string, strategyId: string, source: CloseSource): StrategyTotals | undefined {
  return statement(db,
    `SELECT closes, net_newest_first netNewestFirst, first_ts firstTs, first_entry_ts firstEntryTs, last_ts lastTs
     FROM strategy_totals WHERE instance_id=? AND strategy_id=? AND source=?`,
  ).get(instanceId, strategyId, source) as StrategyTotals | undefined;
}

