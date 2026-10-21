import type { Db } from "./db.js";
import { statement } from "./statements.js";

const MARKS_IN_WINDOW = `
  SELECT MIN(v.profit) lowest, MAX(v.profit) highest, COUNT(v.profit) n FROM position_valuations v
  WHERE v.instance_id=? AND v.ticket=? AND v.ts>=? AND v.ts<=? AND (v.strategy_id=? OR v.strategy_id IS NULL)`;

/**
 * Rewrites the excursion rows of these closed trades from the stored marks: their position's
 * marks inside each trade's held window, counted for the trade's owner or unattributed. A trade
 * without an entry or a position ticket has none.
 */
export function recomputeExcursions(db: Db, dealRowids: number[]): void {
  const del = statement(db, "DELETE FROM position_excursions WHERE deal_rowid=?");
  const trade = statement(db,
    "SELECT instance_id instanceId, position_ticket ticket, strategy_id strategyId, entry_ts lo, ts hi FROM closed_trades WHERE deal_rowid=?",
  );
  const marks = statement(db, MARKS_IN_WINDOW);
  const ins = statement(db,
    "INSERT INTO position_excursions (deal_rowid, instance_id, ticket, strategy_id, lo, hi, lowest, highest, marks) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (const rowid of dealRowids) {
    del.run(rowid);
    const t = trade.get(rowid) as { instanceId: string; ticket: string | null; strategyId: string | null; lo: number | null; hi: number } | undefined;
    if (!t || !t.ticket || t.lo == null) continue;
    const m = marks.get(t.instanceId, t.ticket, t.lo, t.hi, t.strategyId) as { lowest: number | null; highest: number | null; n: number };
    ins.run(rowid, t.instanceId, t.ticket, t.strategyId, t.lo, t.hi, m.lowest, m.highest, m.n);
  }
}

/** Recomputes every closed trade of a position after one of its marks was removed or changed. */
export function recomputeTicketExcursions(db: Db, instanceId: string, ticket: string): void {
  const rows = statement(db, "SELECT deal_rowid r FROM closed_trades WHERE instance_id=? AND position_ticket=?").all(instanceId, ticket) as Array<{ r: number }>;
  recomputeExcursions(db, rows.map((x) => x.r));
}

export function excursionsAfter(db: Db, after: number, limit: number): number[] {
  return (statement(db, "SELECT deal_rowid r FROM closed_trades WHERE deal_rowid>? ORDER BY deal_rowid LIMIT ?").all(after, limit) as Array<{ r: number }>).map((x) => x.r);
}

export function clearExcursions(db: Db): void {
  statement(db, "DELETE FROM position_excursions").run();
  statement(db, "DELETE FROM projection_dirty WHERE kind='excursion'").run();
}

export interface Excursion { lowest: number | null; highest: number | null; marks: number }

/** The excursion of each of these closed trades that has one, by closing deal rowid. One indexed lookup per trade. */
export function excursionsOf(db: Db, dealRowids: number[]): Map<number, Excursion> {
  const rows = statement(db,
    "SELECT deal_rowid r, lowest, highest, marks FROM position_excursions WHERE deal_rowid IN (SELECT value FROM json_each(?))",
  ).all(JSON.stringify(dealRowids)) as Array<Excursion & { r: number }>;
  return new Map(rows.map(({ r, ...e }) => [r, e]));
}
