import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { cumulativeRounding, instanceMoneyDigits } from "./money.js";
import { LEDGER_COVERED } from "./roundTrips.js";

/** Closing legs of a position: the deal entries that take volume off it. */
export const OUT_LEGS = "('OUT','INOUT','OUT_BY')";

/** A closed_trades row as the reducers compare it: what a close changed, and for whom. */
export interface ClosedTradeKey { dealRowid: number; strategyId: string | null; ts: number; realized: number | null }

/**
 * The closed-trade rows of one position, from its legs in `deals`. Each canonical closing leg is
 * paired with the position's first IN leg (any copy) for its entry; realized is the closing leg's
 * profit and costs, plus its share of every canonical IN leg's costs: the costs of all the
 * position's opening legs times the closed volume over the opened volume (capped at all of it). A
 * scaled-in position so pays each entry's costs, a partial close pays only its part, and the closes
 * of a fully closed position add up to the net of all its legs, as its round trip does. One entry
 * closed at once pays exactly its entry's costs (the share is 1). The arithmetic is SQL so the
 * stored figure is the one the reads always computed.
 */
const POSITION_ROWS = (where: string) => `
  SELECT o.rowid deal_rowid, o.instance_id, o.strategy_id, o.position_ticket, o.ts, o.symbol, o.side out_side,
         i.side in_side, o.qty, i.price entry_price, o.price exit_price, i.ts entry_ts,
         o.profit + COALESCE(o.commission,0) + COALESCE(o.swap,0) + COALESCE(o.fee,0)
           + COALESCE((
               SELECT CASE WHEN SUM(e.qty) > 0
                 THEN SUM(COALESCE(e.commission,0) + COALESCE(e.swap,0) + COALESCE(e.fee,0)) * (MIN(o.qty, SUM(e.qty)) / SUM(e.qty)) END
               FROM deals e
               WHERE e.instance_id=o.instance_id AND e.position_ticket=o.position_ticket AND e.entry='IN' AND e.canonical=1), 0) realized,
         i.order_ticket entry_order_ticket, o.order_ticket exit_order_ticket
  FROM deals o
  LEFT JOIN deals i ON i.rowid = (
    SELECT rowid FROM deals x
    WHERE x.instance_id=o.instance_id AND x.position_ticket=o.position_ticket AND x.entry='IN'
    ORDER BY x.ts ASC LIMIT 1
  )
  WHERE ${where} AND o.entry IN ${OUT_LEGS} AND o.canonical=1`;

const COLUMNS = "deal_rowid, instance_id, strategy_id, position_ticket, ts, symbol, out_side, in_side, qty, entry_price, exit_price, entry_ts, realized, entry_order_ticket, exit_order_ticket";

/**
 * Whether the position counts as fully closed with every leg up to `to`: its IN volume matched by
 * OUT legs and no reversal (INOUT) among them. Evaluated per leg timestamp, which is where it can
 * change.
 */
const CLOSED_AT = `
  SELECT t.ts ts, (SELECT CASE WHEN SUM(CASE WHEN fc.entry='INOUT' THEN 1 ELSE 0 END) = 0
                                AND SUM(CASE WHEN fc.entry='IN' THEN fc.qty ELSE 0 END) > 0
                                AND SUM(CASE WHEN fc.entry IN ('OUT','OUT_BY') THEN fc.qty ELSE 0 END)
                                    >= SUM(CASE WHEN fc.entry='IN' THEN fc.qty ELSE 0 END) - 1e-9
                           THEN 1 ELSE 0 END
                   FROM deals fc
                   WHERE fc.instance_id=@instanceId AND fc.position_ticket=@position AND fc.ts<=t.ts AND fc.canonical=1) closed
  FROM (SELECT DISTINCT ts FROM deals WHERE instance_id=@instanceId AND position_ticket=@position AND canonical=1) t
  ORDER BY t.ts`;

function rowsOf(db: Db, sql: string, params: unknown[]): ClosedTradeKey[] {
  return statement(db, sql).all(...params) as ClosedTradeKey[];
}

/**
 * Rebuilds the closed_trades and position_closures rows of one position key ("p:<ticket>", or
 * "d:<deal rowid>" for a leg without a position ticket) and returns its rows before and after.
 * O(legs of the position).
 */
export function recomputePosition(db: Db, instanceId: string, key: string): { before: ClosedTradeKey[]; after: ClosedTradeKey[] } {
  const keyed = "deal_rowid dealRowid, strategy_id strategyId, ts, realized";
  if (key.startsWith("d:")) {
    const rowid = Number(key.slice(2));
    const before = rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE deal_rowid=?`, [rowid]);
    statement(db, "DELETE FROM closed_trades WHERE deal_rowid=?").run(rowid);
    statement(db, `INSERT INTO closed_trades (${COLUMNS}) ${POSITION_ROWS("o.rowid=@rowid AND o.position_ticket IS NULL")}`).run({ rowid });
    roundToMinorUnit(db, instanceId, rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE deal_rowid=?`, [rowid]));
    return { before, after: rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE deal_rowid=?`, [rowid]) };
  }
  const position = key.slice(2);
  const before = rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE instance_id=? AND position_ticket=?`, [instanceId, position]);
  statement(db, "DELETE FROM closed_trades WHERE instance_id=? AND position_ticket=?").run(instanceId, position);
  statement(db, `INSERT INTO closed_trades (${COLUMNS}) ${POSITION_ROWS("o.instance_id=@instanceId AND o.position_ticket=@position")}`)
    .run({ instanceId, position });
  roundToMinorUnit(db, instanceId,
    rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE instance_id=? AND position_ticket=? ORDER BY ts ASC, deal_rowid ASC`, [instanceId, position]));
  writeClosures(db, instanceId, position);
  return { before, after: rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE instance_id=? AND position_ticket=?`, [instanceId, position]) };
}

/**
 * Stores a position's closes at the account currency's minor unit, rounding the running total
 * rather than each close: a close is its running total at that unit minus the one before it, so
 * the closes of a position add up exactly to its net at that unit (its round trip), and each is
 * within one minor unit of its share. A whole close of venue amounts is unchanged by this.
 */
function roundToMinorUnit(db: Db, instanceId: string, rows: ClosedTradeKey[]): void {
  const digits = instanceMoneyDigits(db, instanceId);
  const rounded = cumulativeRounding(rows.map((r) => r.realized ?? 0), digits);
  const set = statement(db, "UPDATE closed_trades SET realized=? WHERE deal_rowid=?");
  rows.forEach((r, i) => { if (r.realized != null && r.realized !== rounded[i]) set.run(rounded[i], r.dealRowid); });
}

function writeClosures(db: Db, instanceId: string, position: string): void {
  statement(db, "DELETE FROM position_closures WHERE instance_id=? AND position_ticket=?").run(instanceId, position);
  const points = statement(db, CLOSED_AT).all({ instanceId, position }) as Array<{ ts: number; closed: number }>;
  const ins = statement(db, "INSERT INTO position_closures (instance_id, position_ticket, from_ts, until_ts) VALUES (?,?,?,?)");
  let from: number | null = null;
  for (const p of points) {
    if (p.closed === 1 && from == null) from = p.ts;
    else if (p.closed !== 1 && from != null) {
      ins.run(instanceId, position, from, p.ts);
      from = null;
    }
  }
  if (from != null) ins.run(instanceId, position, from, null);
}

/**
 * SQL: rows `a` and `b` are copies of one venue deal: the same ticket on the same account. Every broker
 * profile polling an account stores the account's deals, while two accounts can number their deals alike
 * (a gateway paper account counts paper-1, paper-2, ...). A copy that states no account (an older qkt)
 * matches any account.
 */
export const SAME_DEAL = (a: string, b: string) =>
  `${a}.instance_id=${b}.instance_id AND ${a}.deal_ticket=${b}.deal_ticket
   AND (${a}.account_id IS NULL OR ${b}.account_id IS NULL OR ${a}.account_id=${b}.account_id)`;

/** Whether `deals` is the first-stored copy of its deal (SAME_DEAL). */
const FIRST_COPY = `NOT EXISTS (SELECT 1 FROM deals d WHERE ${SAME_DEAL("d", "deals")} AND d.rowid<deals.rowid)`;

/** Recomputes the canonical copy of a deal ticket (after a copy was removed or renumbered) and marks its positions. */
export function recomputeTicket(db: Db, instanceId: string, dealTicket: string): void {
  statement(db,
    `UPDATE deals SET canonical = ${FIRST_COPY} WHERE instance_id=? AND deal_ticket=?`,
  ).run(instanceId, dealTicket);
  statement(db,
    `INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key)
     SELECT 'position', instance_id, COALESCE('p:' || position_ticket, 'd:' || rowid) FROM deals WHERE instance_id=? AND deal_ticket=?`,
  ).run(instanceId, dealTicket);
}

/**
 * The next `limit` position keys after `after` in (instance, position ticket) order, then the legs
 * without a position ticket, then the engine closes ("l:<id>") no deal stands for: the units
 * a rebuild works through in batches. Seeks the position index, so each batch costs O(log n + limit).
 */
export function positionKeysAfter(db: Db, after: { instanceId: string; key: string } | null, limit: number): Array<{ instanceId: string; key: string }> {
  const out: Array<{ instanceId: string; key: string }> = [];
  const stage = after == null ? "p" : after.key.slice(0, 1);
  if (stage === "p") {
    const rows = statement(db,
      `SELECT DISTINCT instance_id instanceId, position_ticket position FROM deals
       WHERE position_ticket IS NOT NULL AND (instance_id, position_ticket) > (?, ?)
       ORDER BY instance_id, position_ticket LIMIT ?`,
    ).all(after?.instanceId ?? "", after ? after.key.slice(2) : "", limit) as Array<{ instanceId: string; position: string }>;
    for (const r of rows) out.push({ instanceId: r.instanceId, key: `p:${r.position}` });
    if (out.length === limit) return out;
  }
  if (stage === "p" || stage === "d") {
    const lastRowid = stage === "d" ? Number(after!.key.slice(2)) : 0;
    const rows = statement(db,
      "SELECT instance_id instanceId, rowid FROM deals WHERE position_ticket IS NULL AND rowid > ? ORDER BY rowid LIMIT ?",
    ).all(lastRowid, limit - out.length) as Array<{ instanceId: string; rowid: number }>;
    for (const r of rows) out.push({ instanceId: r.instanceId, key: `d:${r.rowid}` });
    if (out.length === limit) return out;
  }
  const from = stage === "l" ? { instanceId: after!.instanceId, id: after!.key.slice(2) } : { instanceId: "", id: "" };
  const rows = statement(db,
    `SELECT c.instance_id instanceId, c.id FROM trade_closes c
     WHERE (c.instance_id, c.id) > (?, ?) AND NOT ${LEDGER_COVERED("c")}
     ORDER BY c.instance_id, c.id LIMIT ?`,
  ).all(from.instanceId, from.id, limit - out.length) as Array<{ instanceId: string; id: string }>;
  for (const r of rows) out.push({ instanceId: r.instanceId, key: `l:${r.id}` });
  return out;
}

/**
 * Takes in deals stored since the last call, by whatever writer: flags each row's canonical copy
 * and queues its position. O(new rows); nothing to do is one seek.
 */
export function takeNewDeals(db: Db): void {
  const wm = (statement(db, "SELECT last_rowid r FROM projection_watermarks WHERE source='deals'").get() as { r: number } | undefined)?.r ?? 0;
  const max = (statement(db, "SELECT MAX(rowid) m FROM deals").get() as { m: number | null }).m ?? 0;
  if (max <= wm) {
    if (max < wm) statement(db, "UPDATE projection_watermarks SET last_rowid=? WHERE source='deals'").run(max);
    return;
  }
  statement(db,
    `UPDATE deals SET canonical = ${FIRST_COPY} WHERE rowid > ?`,
  ).run(wm);
  // An adjustment is money on its owner's day but no closed trade, so no position recompute queues that day.
  statement(db,
    `INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key)
     SELECT DISTINCT 'daily', n.instance_id, 'deal' || char(0) || n.strategy_id || char(0) || date(n.ts / 1000, 'unixepoch') FROM deals n
     WHERE n.rowid > ? AND n.entry='ADJUSTMENT' AND n.strategy_id IS NOT NULL`,
  ).run(wm);
  // A strategy's or a broker's first deals make its venue positions its round trips, in place of its engine closes.
  statement(db,
    `DELETE FROM round_trips WHERE source='ledger' AND EXISTS (SELECT 1 FROM deals n WHERE n.rowid > ? AND n.instance_id=round_trips.instance_id
       AND (n.strategy_id=round_trips.strategy_id OR n.broker=upper(substr(round_trips.symbol, 1, instr(round_trips.symbol, ':') - 1))))`,
  ).run(wm);
  statement(db,
    `INSERT INTO projection_dirty (kind, instance_id, key)
     SELECT DISTINCT 'position', n.instance_id, COALESCE('p:' || n.position_ticket, 'd:' || n.rowid) FROM deals n
     WHERE n.rowid > ? AND NOT EXISTS (SELECT 1 FROM projection_dirty q WHERE q.kind='position' AND q.instance_id=n.instance_id
                                         AND q.key=COALESCE('p:' || n.position_ticket, 'd:' || n.rowid))`,
  ).run(wm);
  statement(db, "INSERT INTO projection_watermarks (source, last_rowid) VALUES ('deals', ?) ON CONFLICT(source) DO UPDATE SET last_rowid=excluded.last_rowid").run(max);
}

/** Empties the closed-trade projection before a full rebuild. */
export function clearClosedTrades(db: Db): void {
  statement(db,
    `UPDATE deals SET canonical = ${FIRST_COPY}`,
  ).run();
  statement(db, "DELETE FROM closed_trades").run();
  statement(db, "DELETE FROM position_closures").run();
  statement(db, "DELETE FROM round_trips").run();
  statement(db, "DELETE FROM projection_dirty WHERE kind IN ('position','ticket')").run();
  statement(db,
    "INSERT INTO projection_watermarks (source, last_rowid) SELECT 'deals', COALESCE(MAX(rowid), 0) FROM deals WHERE true ON CONFLICT(source) DO UPDATE SET last_rowid=excluded.last_rowid",
  ).run();
}
