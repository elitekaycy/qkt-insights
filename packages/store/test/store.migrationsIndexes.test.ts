import { describe, it, expect } from "vitest";
import { openDb } from "../src/index.js";

/** Indexes the deals analytics depend on for their correlated subqueries. Losing one
 *  does not break a query, it makes it O(n^2): the canonical-deal predicate rescanned
 *  every deal per candidate row (2.9 s for one strategy's close count on a 4.8k-deal
 *  DB) until idx_deals_ticket existed. */
describe("deals indexes", () => {
  it("creates the (instance_id, deal_ticket) index the canonical-deal predicate seeks on", () => {
    const db = openDb(":memory:");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deals'").all() as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["idx_deals_ticket", "idx_deals_position", "idx_deals_strategy", "idx_deals_lookup"]));
    const plan = (db.prepare(
      `EXPLAIN QUERY PLAN SELECT count(*) FROM deals o WHERE o.instance_id=? AND o.strategy_id=? AND o.entry IN ('OUT','INOUT','OUT_BY')
         AND o.rowid=(SELECT MIN(dd.rowid) FROM deals dd WHERE dd.instance_id=o.instance_id AND dd.deal_ticket=o.deal_ticket)`,
    ).all("i", "s") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_deals_ticket");
  });
});
