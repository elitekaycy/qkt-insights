import type { Db } from "./db.js";
import { statement } from "./statements.js";

/** Closing legs of a position: the deal entries that take volume off it. */
export const OUT_LEGS = "('OUT','INOUT','OUT_BY')";

/** A closed_trades row as the reducers compare it: what a close changed, and for whom. */
export interface ClosedTradeKey { dealRowid: number; strategyId: string | null; ts: number; realized: number | null }

/**
 * The closed-trade rows of one position, from its legs in `deals`. Each canonical closing leg is
 * paired with the position's first IN leg (any copy); realized is the closing leg's profit and
 * costs, plus the IN leg's costs on the position's first canonical close only. The arithmetic is
 * SQL so the stored figure is the one the reads always computed.
 */
const POSITION_ROWS = (where: string) => `
  SELECT o.rowid deal_rowid, o.instance_id, o.strategy_id, o.position_ticket, o.ts, o.symbol, o.side out_side,
         i.side in_side, o.qty, i.price entry_price, o.price exit_price, i.ts entry_ts,
         o.profit + COALESCE(o.commission,0) + COALESCE(o.swap,0) + COALESCE(o.fee,0)
           + CASE WHEN o.rowid = (
               SELECT f.rowid FROM deals f
               WHERE f.instance_id=o.instance_id AND f.position_ticket=o.position_ticket
                 AND f.entry IN ${OUT_LEGS} AND f.canonical=1
               ORDER BY f.ts ASC, f.rowid ASC LIMIT 1)
             THEN COALESCE(i.commission,0) + COALESCE(i.swap,0) + COALESCE(i.fee,0) ELSE 0 END realized,
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
    return { before, after: rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE deal_rowid=?`, [rowid]) };
  }
  const position = key.slice(2);
  const before = rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE instance_id=? AND position_ticket=?`, [instanceId, position]);
  statement(db, "DELETE FROM closed_trades WHERE instance_id=? AND position_ticket=?").run(instanceId, position);
  statement(db, `INSERT INTO closed_trades (${COLUMNS}) ${POSITION_ROWS("o.instance_id=@instanceId AND o.position_ticket=@position")}`)
    .run({ instanceId, position });
  writeClosures(db, instanceId, position);
  return { before, after: rowsOf(db, `SELECT ${keyed} FROM closed_trades WHERE instance_id=? AND position_ticket=?`, [instanceId, position]) };
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

/** Recomputes the canonical copy of a deal ticket (after a copy was removed or renumbered) and marks its positions. */
export function recomputeTicket(db: Db, instanceId: string, dealTicket: string): void {
  statement(db,
    `UPDATE deals SET canonical = (rowid = (SELECT MIN(dd.rowid) FROM deals dd WHERE dd.instance_id=deals.instance_id AND dd.deal_ticket=deals.deal_ticket))
     WHERE instance_id=? AND deal_ticket=?`,
  ).run(instanceId, dealTicket);
  statement(db,
    `INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key)
     SELECT 'position', instance_id, COALESCE('p:' || position_ticket, 'd:' || rowid) FROM deals WHERE instance_id=? AND deal_ticket=?`,
  ).run(instanceId, dealTicket);
}

/**
 * The next `limit` position keys after `after` in (instance, position ticket) order, then the legs
 * without a position ticket: the units a rebuild works through in batches. Seeks the position
 * index, so each batch costs O(log n + limit).
 */
export function positionKeysAfter(db: Db, after: { instanceId: string; key: string } | null, limit: number): Array<{ instanceId: string; key: string }> {
  const out: Array<{ instanceId: string; key: string }> = [];
  if (after == null || after.key.startsWith("p:")) {
    const rows = statement(db,
      `SELECT DISTINCT instance_id instanceId, position_ticket position FROM deals
       WHERE position_ticket IS NOT NULL AND (instance_id, position_ticket) > (?, ?)
       ORDER BY instance_id, position_ticket LIMIT ?`,
    ).all(after?.instanceId ?? "", after ? after.key.slice(2) : "", limit) as Array<{ instanceId: string; position: string }>;
    for (const r of rows) out.push({ instanceId: r.instanceId, key: `p:${r.position}` });
    if (out.length === limit) return out;
  }
  const lastRowid = after?.key.startsWith("d:") ? Number(after.key.slice(2)) : 0;
  const rows = statement(db,
    "SELECT instance_id instanceId, rowid FROM deals WHERE position_ticket IS NULL AND rowid > ? ORDER BY rowid LIMIT ?",
  ).all(lastRowid, limit - out.length) as Array<{ instanceId: string; rowid: number }>;
  for (const r of rows) out.push({ instanceId: r.instanceId, key: `d:${r.rowid}` });
  return out;
}

/** Empties the closed-trade projection before a full rebuild. */
export function clearClosedTrades(db: Db): void {
  statement(db,
    `UPDATE deals SET canonical = (rowid = (SELECT MIN(dd.rowid) FROM deals dd WHERE dd.instance_id=deals.instance_id AND dd.deal_ticket=deals.deal_ticket))`,
  ).run();
  statement(db, "DELETE FROM closed_trades").run();
  statement(db, "DELETE FROM position_closures").run();
  statement(db, "DELETE FROM round_trips").run();
  statement(db, "DELETE FROM projection_dirty WHERE kind IN ('position','ticket')").run();
}
