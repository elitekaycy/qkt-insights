import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import {
  openDb, ingestEvents, listRoundTrips, roundTripTotals, roundTripFacets, roundTripDetail, roundTripPages, dealClosedTrades, refreshProjections, type Db,
} from "../src/index.js";

const I = "qkt-prod";
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 8); // Mon 2026-10-12 08:00 UTC
let seq = 1;

function env(type: string, ts: number, payload: Record<string, unknown>, strategyId?: string, id?: string): Envelope {
  return { v: 1, instanceId: I, id: id ?? `e${seq}`, seq: seq++, ts, type, strategyId, payload } as Envelope;
}

function deal(p: {
  ticket: string; position: string; entry: "IN" | "OUT"; side: "BUY" | "SELL"; ts: number; price: number; qty?: number;
  profit?: number; commission?: number; swap?: number; comment?: string; strategyId?: string | null; order?: string; broker?: string;
}): Envelope {
  const broker = p.broker ?? "ICMARKETS";
  return env("broker.deal", p.ts, {
    broker, dealTicket: p.ticket, positionTicket: p.position, orderTicket: p.order ?? p.position, symbol: `${broker}:XAUUSD`, side: p.side,
    entry: p.entry, qty: p.qty ?? 0.5, price: p.price, profit: p.profit ?? 0, commission: p.commission ?? 0, swap: p.swap ?? 0,
    comment: p.comment ?? "", ts: p.ts, strategyId: p.strategyId === undefined ? "gold_pullback" : p.strategyId,
  }, p.strategyId === null ? undefined : (p.strategyId ?? "gold_pullback"), `deal-${broker}-${p.ticket}`);
}

/** The engine side of an entry: signal, decision link, bracket submit with stop/target/reference, accept, fill. */
function entryEvents(s: string, orderId: string, position: string, ts: number, side: "BUY" | "SELL", stop: number, target: number, ref: number, fill: number): Envelope[] {
  return [
    env("decision.rule_evaluated", ts - 50, { decisionId: `${orderId}-d`, ruleId: "gold#0", conditionResult: true, timeframe: "15m" }, s),
    env("signal", ts - 40, { symbol: "ICMARKETS:XAUUSD", side, qty: 0.5, intent: "SUBMIT", order: { orderId: `${orderId}-plan`, entry: { orderId } } }, s),
    env("decision.order_linked", ts - 39, { decisionId: `${orderId}-d`, ruleId: "gold#0", signalIndex: 0, orderId: `${orderId}-plan` }, s),
    env("order.submit", ts - 30, { orderId, orderType: "Bracket", symbol: "ICMARKETS:XAUUSD", side, qty: 0.5, stopLoss: { type: "Fixed", price: stop }, takeProfit: target, referencePrice: ref, planOrderId: `${orderId}-plan` }, s),
    env("order.accepted", ts + 200, { orderId, brokerOrderId: position }, s),
    env("order.filled", ts + 210, { orderId, brokerOrderId: position, symbol: "ICMARKETS:XAUUSD", price: fill, qty: 0.5 }, s),
  ];
}

/**
 * - 100: long 0.5 @ 4000, stop 3990 target 4020, ref 3999.8; target hit @ 4020 (+1000, commission -7 on entry): +993, R ≈ 1.99
 * - 101: short 0.5 @ 4050, stop 4060; stopped @ 4061 (-550): R -1.1 (venue paid 50/pt)
 * - 102: long 0.5 @ 4100, no engine events; closed by a strategy close order @ 4090 (-500), unattributed on the IN but the OUT names it
 * - 103: unattributed long, closed @ 4210 (+250), comment empty and no events: ended unknown
 * - 104: long still open
 * - a copy of deal 2 under another broker profile, which must not double anything
 */
function seeded(): Db {
  seq = 1;
  const db = openDb(":memory:");
  ingestEvents(db, I, [
    ...entryEvents("gold_pullback", "o-100", "100", T0, "BUY", 3990, 4020, 3999.8, 4000),
    deal({ ticket: "1", position: "100", entry: "IN", side: "BUY", ts: T0 + 100, price: 4000, commission: -7 }),
    env("order.filled", T0 + 2 * H + 50, { orderId: "o-100", brokerOrderId: "100", symbol: "ICMARKETS:XAUUSD", price: 4020, qty: 0.5, exitReason: "TAKE_PROFIT" }, "gold_pullback"),
    deal({ ticket: "2", position: "100", entry: "OUT", side: "SELL", ts: T0 + 2 * H, price: 4020, profit: 1000, comment: "[tp 4020.00]", order: "900" }),
    deal({ ticket: "2", position: "100", entry: "OUT", side: "SELL", ts: T0 + 2 * H, price: 4020, profit: 1000, comment: "[tp 4020.00]", order: "900", broker: "ICM_S05", strategyId: "other_guess" }),

    ...entryEvents("gold_pullback", "o-101", "101", T0 + D, "SELL", 4060, 4030, 4050, 4050),
    deal({ ticket: "3", position: "101", entry: "IN", side: "SELL", ts: T0 + D + 100, price: 4050 }),
    deal({ ticket: "4", position: "101", entry: "OUT", side: "BUY", ts: T0 + D + 30 * MIN, price: 4061, profit: -550, comment: "[sl 4060.00]", order: "901" }),

    deal({ ticket: "5", position: "102", entry: "IN", side: "BUY", ts: T0 + 2 * D, price: 4100, strategyId: null }),
    env("order.submit", T0 + 2 * D + 5 * H - 500, { orderId: "o-close-102", orderType: "Market", symbol: "ICMARKETS:XAUUSD", side: "SELL", qty: 0.5, closesTicket: "102", referencePrice: 4091 }, "gold_pullback"),
    deal({ ticket: "6", position: "102", entry: "OUT", side: "SELL", ts: T0 + 2 * D + 5 * H, price: 4090, profit: -500, order: "902" }),

    deal({ ticket: "7", position: "103", entry: "IN", side: "BUY", ts: T0 + 3 * D, price: 4200, strategyId: null }),
    deal({ ticket: "8", position: "103", entry: "OUT", side: "SELL", ts: T0 + 3 * D + 20 * MIN, price: 4210, profit: 250, strategyId: null, order: "903" }),

    deal({ ticket: "9", position: "104", entry: "IN", side: "BUY", ts: T0 + 4 * D, price: 4300 }),
  ]);
  return db;
}

const q = (text = "", extra: Record<string, unknown> = {}) => ({ instanceId: I, filter: parseQuery(text).filter, ...extra });
const ids = (db: Db, text = "", extra: Record<string, unknown> = {}) => listRoundTrips(db, q(text, extra)).rows.map((r) => r.id);

describe("round trips from venue deals", () => {
  it("adds up to the net of the venue's deals on closed positions, to the cent", () => {
    const db = seeded();
    refreshProjections(db);
    const deals = db.prepare(`SELECT COALESCE(SUM(profit + COALESCE(commission,0) + COALESCE(swap,0) + COALESCE(fee,0)), 0) n FROM deals d
      WHERE instance_id=? AND canonical=1 AND position_ticket IN (SELECT position_ticket FROM round_trips WHERE instance_id=? AND open=0)`).get(I, I) as { n: number };
    const totals = roundTripTotals(db, q("closed"));
    expect(Math.round(totals.net * 100)).toBe(Math.round(deals.n * 100));
    expect(totals.net).toBeCloseTo(993 - 550 - 500 + 250, 9);
  });

  it("one row per position, entry to exit, with the closed-trade builder's P&L", () => {
    const db = seeded();
    const rows = listRoundTrips(db, q()).rows;
    expect(rows.map((r) => r.id)).toEqual(["104", "103", "102", "101", "100"]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("100")).toMatchObject({
      strategyId: "gold_pullback", instrument: "XAUUSD", side: "long", status: "closed", entryTs: T0 + 100, entryPrice: 4000, exitTs: T0 + 2 * H,
      exitPrice: 4020, qty: 0.5, pnl: 993, holdMs: 2 * H - 100, stopPrice: 3990, targetPrice: 4020, ended: "tp", legs: 2, entryOrderId: "o-100",
      priceDigits: 2,
    });
    // risk: the venue paid 1000 for 20 points, so 10 points to the stop is 500
    expect(byId.get("100")!.risk).toBeCloseTo(500, 6);
    expect(byId.get("100")!.r).toBeCloseTo(993 / 500, 6);
    expect(byId.get("101")).toMatchObject({ side: "short", pnl: -550, ended: "stop", stopPrice: 4060 });
    expect(byId.get("101")!.r).toBeCloseTo(-1.1, 6);
    expect(byId.get("102")).toMatchObject({ strategyId: "gold_pullback", ended: "signal", r: null, stopPrice: null });
    expect(byId.get("103")).toMatchObject({ strategyId: null, ended: null, pnl: 250 });
    expect(byId.get("104")).toMatchObject({ status: "open", exitTs: null, pnl: null, ended: null, r: null });
    // the same money the strategy's closed-trade list books
    const closes = dealClosedTrades(db, { instanceId: I, strategyId: "gold_pullback" });
    expect(rows.filter((r) => r.strategyId === "gold_pullback").reduce((a, r) => a + (r.pnl ?? 0), 0)).toBeCloseTo(closes.reduce((a, c) => a + c.realized, 0), 9);
  });

  it("rebuilds only what changed: a new close, an attribution repair", () => {
    const db = seeded();
    listRoundTrips(db, q());
    ingestEvents(db, I, [deal({ ticket: "10", position: "104", entry: "OUT", side: "SELL", ts: T0 + 4 * D + H, price: 4310, profit: 500, comment: "[tp 4310]" })]);
    const open = listRoundTrips(db, q("#104")).rows[0]!;
    expect(open).toMatchObject({ status: "closed", pnl: 500, ended: "tp", exitPrice: 4310 });
    db.prepare("UPDATE deals SET strategy_id='late_claim' WHERE instance_id=? AND position_ticket='103'").run(I);
    expect(listRoundTrips(db, q("#103")).rows[0]!.strategyId).toBe("late_claim");
  });
});

describe("filters", () => {
  it("applies every trade tag through SQL", () => {
    const db = seeded();
    expect(ids(db, "side:short")).toEqual(["101"]);
    expect(ids(db, "pnl:<0")).toEqual(["102", "101"]);
    expect(ids(db, "side:short pnl:<0")).toEqual(["101"]);
    expect(ids(db, "pnl:>=250")).toEqual(["103", "100"]);
    expect(ids(db, "r:>=1")).toEqual(["100"]);
    expect(ids(db, "r:<0")).toEqual(["101"]);
    expect(ids(db, "held:<1h")).toEqual(["103", "101"]);
    expect(ids(db, "held:>=4h")).toEqual(["102"]);
    expect(ids(db, "entry:2026-10-13")).toEqual(["101"]);
    expect(ids(db, "exit:2026-10-14")).toEqual(["102"]);
    expect(ids(db, "exit:>=2026-10-14")).toEqual(["103", "102"]);
    expect(ids(db, "ended:stop")).toEqual(["101"]);
    expect(ids(db, "ended:tp")).toEqual(["100"]);
    expect(ids(db, "ended:signal")).toEqual(["102"]);
    expect(ids(db, "size:0.5")).toHaveLength(5);
    expect(ids(db, "size:>1")).toEqual([]);
    expect(ids(db, "#101")).toEqual(["101"]);
    expect(ids(db, "#o-100")).toEqual(["100"]);
    expect(ids(db, "win")).toEqual(["103", "100"]);
    expect(ids(db, "loss")).toEqual(["102", "101"]);
    expect(ids(db, "open")).toEqual(["104"]);
    expect(ids(db, "strategy:gold_pullback")).toEqual(["104", "102", "101", "100"]);
    expect(ids(db, "strategy:unattributed")).toEqual(["103"]);
    expect(ids(db, "symbol:XAUUSD")).toHaveLength(5);
    expect(ids(db, "symbol:EURUSD")).toEqual([]);
    expect(ids(db, "unattr")).toEqual(["103"]);
    expect(ids(db, "stop")).toEqual(["101"]);
  });

  it("free text is bound, never spliced: quotes, LIKE wildcards and SQL stay literal", () => {
    const db = seeded();
    expect(ids(db, "%")).toEqual([]);
    expect(ids(db, "_")).toEqual(["104", "102", "101", "100"]);
    expect(ids(db, `"' OR 1=1 --"`)).toEqual([]);
    expect(ids(db, "gold")).toEqual(["104", "102", "101", "100"]);
  });

  it("scopes: a strategy page, unattributed only, the page's date range", () => {
    const db = seeded();
    expect(ids(db, "", { strategyId: "gold_pullback" })).toEqual(["104", "102", "101", "100"]);
    expect(ids(db, "", { strategyId: null })).toEqual(["103"]);
    expect(ids(db, "", { since: T0 + 2 * D })).toEqual(["104", "103", "102"]);
  });

  it("public scope: allowed strategies, closed by the cutoff, tickets unreachable", () => {
    const db = seeded();
    expect(ids(db, "", { allowed: ["gold_pullback"], closedBy: T0 + 3 * D })).toEqual(["102", "101", "100"]);
    expect(ids(db, "", { allowed: ["gold_pullback"], closedBy: T0 + D + H })).toEqual(["101", "100"]);
    expect(ids(db, "#101", { allowed: ["gold_pullback"], closedBy: T0 + 3 * D })).toEqual(["102", "101", "100"]);
    expect(ids(db, "101", { allowed: ["gold_pullback"], closedBy: T0 + 3 * D })).toEqual([]);
  });
});

describe("sorting and cursors", () => {
  it("sorts by any column, empty values last in both directions", () => {
    const db = seeded();
    expect(ids(db, "", { sort: "pnl", dir: "desc" })).toEqual(["100", "103", "102", "101", "104"]);
    expect(ids(db, "", { sort: "pnl", dir: "asc" })).toEqual(["101", "102", "103", "100", "104"]);
    expect(ids(db, "", { sort: "r", dir: "desc" })).toEqual(["100", "101", "104", "103", "102"]);
    expect(ids(db, "", { sort: "held", dir: "asc" })[0]).toBe("103");
    // ties keep the ticket order of the direction
    expect(ids(db, "", { sort: "strategy", dir: "asc" })).toEqual(["100", "101", "102", "104", "103"]);
  });

  it("pages by cursor without gaps or repeats, and a page stays put when new trades arrive", () => {
    const db = seeded();
    for (const sort of ["entry", "exit", "pnl", "r", "held", "strategy", "ended"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const all = ids(db, "", { sort, dir, limit: 100 });
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const page = listRoundTrips(db, q("", { sort, dir, limit: 2, cursor }));
          paged.push(...page.rows.map((r) => r.id));
          cursor = page.nextCursor;
        } while (cursor);
        expect(paged, `${sort} ${dir}`).toEqual(all);
      }
    }
    const first = listRoundTrips(db, q("", { limit: 2 }));
    ingestEvents(db, I, [deal({ ticket: "20", position: "200", entry: "IN", side: "BUY", ts: T0 + 6 * D, price: 4400 })]);
    expect(listRoundTrips(db, q("", { limit: 2, cursor: first.nextCursor })).rows.map((r) => r.id)).toEqual(["102", "101"]);
    expect(listRoundTrips(db, q("", { cursor: "not-a-cursor" })).rows).toHaveLength(6);
  });

  it("exports every match page by page", () => {
    const db = seeded();
    expect([...roundTripPages(db, q("pnl:<0"), 1)].flat().map((r) => r.id)).toEqual(["102", "101"]);
  });
});

describe("totals and facets", () => {
  it("counts and money of the whole match, beside the unfiltered scope", () => {
    const db = seeded();
    expect(roundTripTotals(db, q())).toEqual({ total: 5, matched: 5, closed: 4, open: 1, net: 193, netInExit: false, wins: 2, losses: 2, winRate: 50, avg: 193 / 4, best: 993, worst: -550 });
    expect(roundTripTotals(db, q("side:short pnl:<0"))).toMatchObject({ total: 5, matched: 1, net: -550, wins: 0, losses: 1, winRate: 0 });
    expect(roundTripTotals(db, q("size:>9"))).toMatchObject({ matched: 0, net: 0, winRate: null, avg: null });
  });

  it("lists what completions can offer", () => {
    const db = seeded();
    expect(roundTripFacets(db, { instanceId: I })).toEqual({
      strategies: [{ id: "gold_pullback", n: 4 }, { id: null, n: 1 }],
      instruments: [{ name: "XAUUSD", n: 5 }],
      days: ["2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"],
      sizes: [0.5],
    });
  });
});

describe("one round trip in full", () => {
  it("assembles legs, the engine timeline, slippage and the raw events", () => {
    const db = seeded();
    const d = roundTripDetail(db, I, "100")!;
    expect(d.legs.map((l) => [l.dealTicket, l.entry, l.net])).toEqual([["1", "IN", -7], ["2", "OUT", 1000]]);
    expect(d.timeline.map((s) => s.kind)).toEqual(["decision", "signal", "submit", "deal", "accepted", "fill", "deal", "fill"]);
    expect(d.timeline[2]).toMatchObject({ title: "Order submitted BUY 0.5", detail: "Bracket · stop 3990.00 · target 4020.00 · reference 3999.80", sinceMs: 10 });
    expect(d.timeline[0]!.sinceMs).toBeNull();
    expect(d.timeline.at(-1)).toMatchObject({ kind: "fill", detail: "exit by target" });
    // paid 0.2 over the reference; the venue priced a point at 50
    expect(d.entrySlippage).toMatchObject({ reference: 3999.8, fill: 4000, basis: "reference price" });
    expect(d.entrySlippage!.points).toBeCloseTo(0.2, 9);
    expect(d.entrySlippage!.money).toBeCloseTo(10, 9);
    expect(d.exitSlippage).toMatchObject({ reference: 4020, fill: 4020, points: 0, money: 0, basis: "target" });
    expect(d.events.map((e) => e.type)).toEqual(["decision.rule_evaluated", "signal", "decision.order_linked", "order.submit", "order.accepted", "order.filled", "order.filled"]);
    expect(d.excursion).toBeNull();
  });

  it("measures a stop's slippage against the stop, a close order's against its reference", () => {
    const db = seeded();
    expect(roundTripDetail(db, I, "101")!.exitSlippage).toMatchObject({ reference: 4060, fill: 4061, points: 1, money: 50, basis: "stop" });
    const close = roundTripDetail(db, I, "102")!;
    expect(close.exitSlippage).toMatchObject({ reference: 4091, fill: 4090, points: 1, money: 50, basis: "reference price" });
    expect(close.timeline.map((s) => s.title)).toContain("Close order submitted SELL 0.5");
  });

  it("reads MAE/MFE from the position's marks, and is null for an unknown id", () => {
    const db = seeded();
    const mark = db.prepare(`INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, profit, strategy_id)
      VALUES (?, 'ICMARKETS', '100', ?, 'ICMARKETS:XAUUSD', 'BUY', 0.5, 4000, ?, 'gold_pullback')`);
    mark.run(I, T0 + H, -120);
    mark.run(I, T0 + H + MIN, 640);
    expect(roundTripDetail(db, I, "100")!.excursion).toEqual({ mae: -120, mfe: 640, marks: 2 });
    expect(roundTripDetail(db, I, "nope")).toBeNull();
  });
});
