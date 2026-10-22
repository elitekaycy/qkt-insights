import { describe, it, expect } from "vitest";
import { openDb, reconcile, reconciliation, refreshProjections, type Db, type VenuePositionsReport } from "../src/index.js";

const I = "i1";
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const ACCOUNT = "mt5:0123456789abcdef";
const OCT = (day: number, hour = 0, minute = 0, second = 0) => Date.UTC(2026, 9, day, hour, minute, second);

interface Deal {
  ticket: string;
  position: string;
  entry: "IN" | "OUT";
  side?: "BUY" | "SELL";
  qty?: number;
  profit?: number;
  commission?: number;
  swap?: number;
  ts: number;
  broker?: string;
  accountId?: string | null;
}

function deal(db: Db, d: Deal): void {
  db.prepare(
    `INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, commission, swap, fee, strategy_id, ts, account_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`d-${d.ticket}`, I, d.broker ?? "ICM_S01", d.ticket, d.position, "ICM:XAUUSD", d.side ?? (d.entry === "IN" ? "BUY" : "SELL"), d.entry,
    d.qty ?? 0.1, 2400, d.profit ?? 0, d.commission ?? 0, d.swap ?? 0, 0, "s1", d.ts, d.accountId === undefined ? ACCOUNT : d.accountId);
}

/** A round trip: IN at `ts - 1h`, OUT at `ts` booking `profit` and `commission` on the close. */
function trip(db: Db, position: string, ts: number, profit: number, commission = 0, extra: Partial<Deal> = {}): number {
  deal(db, { ticket: `${position}-in`, position, entry: "IN", ts: ts - H, ...extra });
  deal(db, { ticket: `${position}-out`, position, entry: "OUT", profit, commission, ts, ...extra });
  return profit + commission;
}

/**
 * Minute rollups every `step` from `from` to `to`, balance = `start` plus every booked amount at or
 * before the minute (what the venue would report when polled exactly on the minute).
 */
function minutes(db: Db, o: { from: number; to: number; start: number; booked: Array<{ ts: number; amount: number }>; label?: string; account?: string | null; step?: number; skip?: (ts: number) => boolean }): void {
  const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,?,?)");
  const booked = [...o.booked].sort((a, b) => a.ts - b.ts);
  db.transaction(() => {
    let i = 0, balance = o.start;
    for (let ts = o.from; ts <= o.to; ts += o.step ?? 10 * M) {
      while (i < booked.length && booked[i]!.ts <= ts) balance += booked[i++]!.amount;
      if (o.skip?.(ts)) continue;
      ins.run(I, o.label ?? "ICM", ts, Math.round(balance * 100) / 100, balance, 0, o.account === undefined ? ACCOUNT : o.account);
    }
  })();
}

const dayOf = (db: Db, day: string) => reconciliation(db, I).accounts[0]!.days.find((d) => d.day === day);

describe("reconciliation: balance continuity per UTC day", () => {
  it("passes a clean day and leaves the first day incomplete, with no snapshot before it", () => {
    const db = openDb(":memory:");
    const a = trip(db, "p1", OCT(2, 9, 0, 30), 152.75, -3.5);
    const b = trip(db, "p2", OCT(2, 15, 20, 10), -40.1, -3.5);
    minutes(db, { from: OCT(1, 6), to: OCT(3, 12), start: 10_000, booked: [{ ts: OCT(2, 9, 0, 30), amount: a }, { ts: OCT(2, 15, 20, 10), amount: b }] });
    reconcile(db, I, { now: OCT(3, 2) });
    const r = reconciliation(db, I);
    expect(r.accounts).toHaveLength(1);
    const acct = r.accounts[0]!;
    expect(acct.account).toBe(ACCOUNT);
    expect(acct.label).toBe("ICM");
    expect(acct.daysOk).toBe(1);
    expect(acct.daysDiff).toBe(0);
    expect(acct.daysIncomplete).toBe(1);
    expect(acct.firstDay).toBe("2026-10-01");
    expect(acct.lastDay).toBe("2026-10-02");
    expect(acct.throughDay).toBe("2026-10-02");
    expect(acct.days).toEqual([expect.objectContaining({ day: "2026-10-01", status: "incomplete", reason: "no-prior-balance" })]);
    expect(acct.checkedAt).toBe(OCT(3, 2));
    expect(r.checkedAt).toBe(OCT(3, 2));
  });

  it("names a balance move with no deal: a deposit, withdrawal or credit", () => {
    const db = openDb(":memory:");
    const a = trip(db, "p1", OCT(2, 9, 0, 30), 80);
    minutes(db, { from: OCT(1, 6), to: OCT(4, 12), start: 10_000, booked: [{ ts: OCT(2, 9, 0, 30), amount: a }, { ts: OCT(3, 12, 0, 5), amount: 1_000 }] });
    reconcile(db, I, { now: OCT(4, 2) });
    const acct = reconciliation(db, I).accounts[0]!;
    expect(acct.daysDiff).toBe(1);
    expect(acct.throughDay).toBe("2026-10-02");
    expect(dayOf(db, "2026-10-03")).toMatchObject({ status: "diff", reason: "no-deals", deals: 0, dealNet: 0, diff: 1_000, balanceChange: 1_000, startBalance: 10_080, endBalance: 11_080 });
  });

  it("finds a deal the venue booked that insights does not have", () => {
    const db = openDb(":memory:");
    const a = trip(db, "p1", OCT(2, 9, 0, 30), 60.4);
    minutes(db, { from: OCT(1, 6), to: OCT(3, 12), start: 5_000, booked: [{ ts: OCT(2, 9, 0, 30), amount: a }, { ts: OCT(2, 13, 0, 30), amount: -25.6 }] });
    reconcile(db, I, { now: OCT(3, 2) });
    expect(dayOf(db, "2026-10-02")).toMatchObject({ status: "diff", reason: "deals-differ", deals: 2, dealNet: 60.4, diff: -25.6, balanceChange: 34.8 });
  });

  it("counts deals made while qkt was down across midnight on the day the next snapshot lands in", () => {
    const db = openDb(":memory:");
    const day = trip(db, "p0", OCT(2, 10, 0, 30), 15);
    const before = trip(db, "p1", OCT(2, 23, 30, 10), 50);
    const after = trip(db, "p2", OCT(3, 1, 30, 10), -20);
    // no snapshot from 22:00 to 02:00: the day's last balance is the 22:00 one
    minutes(db, { from: OCT(1, 6), to: OCT(4, 12), start: 10_000,
      booked: [{ ts: OCT(2, 10, 0, 30), amount: day }, { ts: OCT(2, 23, 30, 10), amount: before }, { ts: OCT(3, 1, 30, 10), amount: after }],
      skip: (ts) => ts > OCT(2, 22) && ts < OCT(3, 2) });
    reconcile(db, I, { now: OCT(4, 2) });
    const acct = reconciliation(db, I).accounts[0]!;
    expect(acct.daysDiff).toBe(0);
    expect(acct.daysOk).toBe(2);
    expect(acct.throughDay).toBe("2026-10-03");
    // both deals are in Oct 3's window, which starts at the last snapshot before the outage
    const rows = db.prepare("SELECT day, start_ts s, end_ts e, deals, deal_net net FROM reconciliations WHERE instance_id=? ORDER BY day").all(I) as Array<{ day: string; s: number; e: number; deals: number; net: number }>;
    expect(rows.find((r) => r.day === "2026-10-02")).toMatchObject({ e: OCT(2, 22), deals: 2 });
    expect(rows.find((r) => r.day === "2026-10-03")).toMatchObject({ s: OCT(2, 22), deals: 4, net: 30 });
  });

  it("never cuts a midnight at a snapshot a deal could straddle", () => {
    const db = openDb(":memory:");
    // booked 30 s before midnight: the 00:00 and 23:59 minutes may or may not hold it
    const a = trip(db, "p1", OCT(2, 23, 59, 30), 12.5);
    minutes(db, { from: OCT(1, 6), to: OCT(3, 12), start: 10_000, step: M, booked: [{ ts: OCT(2, 23, 59, 30), amount: a }] });
    reconcile(db, I, { now: OCT(3, 2) });
    const row = db.prepare("SELECT end_ts e, status FROM reconciliations WHERE instance_id=? AND day='2026-10-02'").get(I) as { e: number; status: string };
    expect(row).toEqual({ e: OCT(2, 23, 58), status: "ok" });
  });

  it("stitches two labels of one venue account into one account", () => {
    const db = openDb(":memory:");
    const a = trip(db, "p1", OCT(2, 9, 0, 30), 100, 0, { broker: "ICM_S01" });
    const b = trip(db, "p2", OCT(3, 15, 0, 30), -30, 0, { broker: "ICM_S05" });
    const booked = [{ ts: OCT(2, 9, 0, 30), amount: a }, { ts: OCT(3, 15, 0, 30), amount: b }];
    minutes(db, { from: OCT(1, 6), to: OCT(2, 12), start: 10_000, booked, label: "ICM" });
    minutes(db, { from: OCT(2, 12, 10), to: OCT(4, 12), start: 10_000, booked, label: "ICM-live" });
    reconcile(db, I, { now: OCT(4, 2) });
    const r = reconciliation(db, I);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ account: ACCOUNT, label: "ICM-live", daysOk: 2, daysDiff: 0, throughDay: "2026-10-03" });
  });

  it("keeps two venue accounts apart and gives each only its own deals", () => {
    const db = openDb(":memory:");
    const other = "mt5:fedcba9876543210";
    const a = trip(db, "p1", OCT(2, 9, 0, 30), 40);
    const b = trip(db, "p2", OCT(2, 10, 0, 30), -15, 0, { broker: "EXN_S01", accountId: other });
    minutes(db, { from: OCT(1, 6), to: OCT(3, 12), start: 10_000, booked: [{ ts: OCT(2, 9, 0, 30), amount: a }] });
    minutes(db, { from: OCT(1, 6), to: OCT(3, 12), start: 2_000, booked: [{ ts: OCT(2, 10, 0, 30), amount: b }], label: "EXN", account: other });
    reconcile(db, I, { now: OCT(3, 2) });
    const r = reconciliation(db, I);
    expect(r.accounts.map((x) => [x.label, x.daysOk, x.daysDiff])).toEqual([["EXN", 1, 0], ["ICM", 1, 0]]);
  });

  it("re-checks only recent and not-ok days, and clears a diff once the late deal arrives", () => {
    const db = openDb(":memory:");
    const booked: Array<{ ts: number; amount: number }> = [];
    for (let day = 1; day <= 20; day++) booked.push({ ts: OCT(day, 10, 0, 30), amount: trip(db, `p${day}`, OCT(day, 10, 0, 30), 10 + day) });
    // the venue booked this one, insights only hears of it later
    booked.push({ ts: OCT(3, 12, 0, 30), amount: -7 });
    minutes(db, { from: OCT(1, 6), to: OCT(21, 1), start: 10_000, booked });
    reconcile(db, I, { now: OCT(21, 2) });
    expect(reconciliation(db, I).accounts[0]).toMatchObject({ daysDiff: 1, daysOk: 18, throughDay: "2026-10-02" });
    const checkedAt = (day: string) => (db.prepare("SELECT checked_at c FROM reconciliations WHERE instance_id=? AND day=?").get(I, day) as { c: number }).c;

    deal(db, { ticket: "late-in", position: "late", entry: "IN", ts: OCT(3, 11, 0, 30) });
    deal(db, { ticket: "late-out", position: "late", entry: "OUT", profit: -7, ts: OCT(3, 12, 0, 30) });
    const r = reconcile(db, I, { now: OCT(21, 3) });
    // Oct 1 (incomplete) and Oct 3 (diff) were not ok; Oct 14..20 are the last RECHECK_DAYS days
    expect(r.daysChecked).toBe(9);
    expect(checkedAt("2026-10-05")).toBe(OCT(21, 2));
    expect(checkedAt("2026-10-03")).toBe(OCT(21, 3));
    expect(checkedAt("2026-10-14")).toBe(OCT(21, 3));
    expect(reconciliation(db, I).accounts[0]).toMatchObject({ daysDiff: 0, daysOk: 19, throughDay: "2026-10-20" });
  });

  it("reads deals and balance points through their indexes", () => {
    const db = openDb(":memory:");
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan("SELECT broker, account_id, profit FROM deals WHERE instance_id='i' AND ts>1 AND ts<=2 AND canonical=1")).toContain("idx_deals_lookup");
    expect(plan("SELECT minute_ts, balance FROM account_equity WHERE instance_id='i' AND broker='b' AND minute_ts<=5 AND balance IS NOT NULL ORDER BY minute_ts DESC LIMIT 1"))
      .toMatch(/USING (PRIMARY KEY|INDEX sqlite_autoindex_account_equity_1)/u);
    expect(plan("SELECT day FROM reconciliations INDEXED BY idx_reconciliations_open WHERE instance_id='i' AND account='a' AND status <> 'ok' ORDER BY day DESC LIMIT 100")).toContain("idx_reconciliations_open");
    expect(plan("SELECT position_ticket FROM round_trips INDEXED BY idx_round_trips_open WHERE instance_id='i' AND open=1 AND source='deal'")).toContain("idx_round_trips_open");
  });
});

describe("reconciliation: open positions", () => {
  const report = (at: number, list: VenuePositionsReport["list"]): VenuePositionsReport[] => [{ broker: "ICM", at, list }];

  function seed(): Db {
    const db = openDb(":memory:");
    deal(db, { ticket: "a-in", position: "A", entry: "IN", side: "BUY", qty: 0.2, ts: OCT(3, 9) });
    deal(db, { ticket: "b-in", position: "B", entry: "IN", side: "SELL", qty: 0.1, ts: OCT(3, 9) });
    deal(db, { ticket: "c-in", position: "C", entry: "IN", side: "BUY", qty: 0.3, ts: OCT(3, 9) });
    // C was partly closed: 0.1 of its 0.3 is left
    deal(db, { ticket: "c-out", position: "C", entry: "OUT", side: "SELL", qty: 0.2, profit: 5, ts: OCT(3, 10) });
    minutes(db, { from: OCT(3, 6), to: OCT(3, 12), start: 10_000, booked: [{ ts: OCT(3, 10), amount: 5 }] });
    return db;
  }

  it("is ok when the venue holds exactly the open round trips", () => {
    const db = seed();
    reconcile(db, I, { now: OCT(3, 12), positions: report(OCT(3, 12) - 5_000, [
      { ticket: "A", symbol: "XAUUSD", side: "BUY", qty: 0.2 },
      { ticket: "B", symbol: "XAUUSD", side: "SELL", qty: 0.1 },
      { ticket: "C", symbol: "XAUUSD", side: "BUY", qty: 0.1 },
    ]) });
    expect(reconciliation(db, I).accounts[0]!.positions).toMatchObject({ status: "ok", venueCount: 3, insightsCount: 3, missing: [], gone: [], mismatched: [] });
  });

  it("lists positions missing in insights, gone at the venue, and side or size mismatches", () => {
    const db = seed();
    reconcile(db, I, { now: OCT(3, 12), positions: report(OCT(3, 12) - 5_000, [
      { ticket: "A", symbol: "XAUUSD", side: "SELL", qty: 0.2 },
      { ticket: "C", symbol: "XAUUSD", side: "BUY", qty: 0.3 },
      { ticket: "Z", symbol: "XAUUSD", side: "BUY", qty: 1, openedAt: OCT(3, 8) },
      // opened a moment ago: its deal may still be on the way
      { ticket: "Y", symbol: "XAUUSD", side: "BUY", qty: 1, openedAt: OCT(3, 12) - 30_000 },
    ]) });
    const p = reconciliation(db, I).accounts[0]!.positions;
    expect(p.status).toBe("diff");
    expect(p.missing).toEqual([{ ticket: "Z", symbol: "XAUUSD", side: "BUY", qty: 1 }]);
    expect(p.gone).toEqual([expect.objectContaining({ ticket: "B", side: "SELL", qty: 0.1 })]);
    expect(p.mismatched).toEqual([
      { ticket: "A", symbol: "XAUUSD", field: "side", venue: "SELL", insights: "BUY" },
      { ticket: "C", symbol: "XAUUSD", field: "qty", venue: 0.3, insights: expect.closeTo(0.1, 9) },
    ]);
  });

  it("is stale without a venue report from the last few minutes", () => {
    const db = seed();
    reconcile(db, I, { now: OCT(3, 12), positions: report(OCT(3, 12) - 10 * M, []) });
    expect(reconciliation(db, I).accounts[0]!.positions).toMatchObject({ status: "stale", venueAt: null, insightsCount: 3 });
    reconcile(db, I, { now: OCT(3, 12) });
    expect(reconciliation(db, I).accounts[0]!.positions.status).toBe("stale");
  });
});

describe("reconciliation: ledger", () => {
  it("is ok when the closed round trips add up to their deals, and names a trip that does not", () => {
    const db = openDb(":memory:");
    const booked = [12.34, -5.67, 0.01, 100.1, -0.2].map((p, i) => ({ ts: OCT(2, 9 + i, 0, 30), amount: trip(db, `p${i}`, OCT(2, 9 + i, 0, 30), p, -0.07) }));
    minutes(db, { from: OCT(2, 6), to: OCT(2, 18), start: 1_000, booked });
    reconcile(db, I, { now: OCT(2, 20) });
    expect(reconciliation(db, I).accounts[0]!.ledger).toMatchObject({ status: "ok", trips: 5, tripsNet: 106.23, dealsNet: 106.23, diff: 0, mismatched: [] });

    refreshProjections(db);
    db.prepare("UPDATE round_trips SET realized = realized + 1 WHERE instance_id=? AND position_ticket='p2'").run(I);
    reconcile(db, I, { now: OCT(2, 20) });
    expect(reconciliation(db, I).accounts[0]!.ledger).toMatchObject({ status: "diff", diff: 1, mismatched: [{ ticket: "p2", realized: 0.94, dealsNet: -0.06 }] });
  });
});

describe("reconciliation: empty", () => {
  it("has no accounts before the first account state and no run before the first reconcile", () => {
    const db = openDb(":memory:");
    expect(reconciliation(db, I)).toEqual({ instanceId: I, digits: 2, checkedAt: null, accounts: [] });
    expect(reconcile(db, I, { now: OCT(3, 2) })).toEqual({ accounts: 0, daysChecked: 0, diffs: 0 });
  });
});

describe("reconciliation: a year of minutes", () => {
  it("checks a year of minute rollups and thousands of deals well under a second", () => {
    const db = openDb(":memory:");
    const from = Date.UTC(2025, 9, 1);
    const to = from + 365 * D;
    const booked: Array<{ ts: number; amount: number }> = [];
    db.transaction(() => {
      // about 14 round trips a day, closes on the half minute
      for (let i = 0; i < 5_000; i++) {
        const ts = from + 6 * H + Math.floor((i * (365 * D - 12 * H)) / 5_000 / M) * M + 30_000;
        booked.push({ ts, amount: trip(db, `p${i}`, ts, ((i * 37) % 200) - 95.5, -1.25) });
      }
    })();
    minutes(db, { from, to, start: 50_000, booked, step: M });
    refreshProjections(db);
    const started = performance.now();
    const r = reconcile(db, I, { now: to + 2 * H });
    const ms = performance.now() - started;
    const again = performance.now();
    reconcile(db, I, { now: to + 3 * H });
    const incrementalMs = performance.now() - again;
    if (process.env.RECONCILE_BENCH) console.log(`reconcile: ${r.daysChecked} days, 525k minutes, 10k deals: full ${ms.toFixed(0)} ms, incremental ${incrementalMs.toFixed(0)} ms`);
    expect(r).toMatchObject({ accounts: 1, diffs: 0 });
    expect(r.daysChecked).toBe(365);
    expect(ms).toBeLessThan(1_000);
    expect(incrementalMs).toBeLessThan(100);
  }, 60_000);
});
