import { describe, it, expect, beforeEach } from "vitest";
import { openDb, ingestEvents, listInstances, listStrategies, listOrders, listTrades, searchEvents, equityCurve, instanceHealth, listDeals, accountEquity, strategyStats, persistStateEvent, listCurrentPositions, listRiskEvents, listPortfolioEquity, replaceRoster } from "../src/index.js";
import type { Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: p.seq ?? 1, ts: p.ts ?? 1718000000000, ...p } as Envelope;
}

let db: Db;
  beforeEach(() => {
  db = openDb(":memory:");
  ingestEvents(db, "qkt-prod", [
    env({ strategyId: "latch", type: "strategy.started", ts: 1717999999000,
      payload: { strategyId: "latch", ts: 1717999999000, sourcePath: "/srv/qkt/latch.qkt", dslVersion: 1, runtimeMode: "paper", symbols: ["XAUUSD"] } }),
    env({ strategyId: "latch", type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1 } }),
    env({ strategyId: "latch", type: "order.filled", payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350, qty: 0.1 } }),
    env({ strategyId: "latch", type: "trade", ts: 1718000001000, payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 0.1, ts: 1718000001000 } }),
    env({ strategyId: "latch", type: "snapshot.equity", ts: 1718000002000, payload: { strategyId: "latch", realized: 5, unrealized: 0, equity: 1005, startingBalance: 1000 } }),
  ]);
  ingestEvents(db, "qkt-demo", [
    env({ instanceId: "qkt-demo", strategyId: "macd", type: "trade", payload: { orderId: "x1", symbol: "EURUSD", side: "SELL", price: 1.08, qty: 1, ts: 1718000000000 } }),
  ]);
});

describe("queries", () => {
  it("lists instances", () => {
    expect(listInstances(db).map((i) => i.id).sort()).toEqual(["qkt-demo", "qkt-prod"]);
  });
  it("lists strategies for an instance", () => {
    const rows = listStrategies(db, "qkt-prod");
    expect(rows.map((s) => s.strategyId)).toEqual(["latch"]);
    expect(rows[0]!.metadata).toMatchObject({ sourcePath: "/srv/qkt/latch.qkt", runtimeMode: "paper" });
  });
  it("marks every strategy active when the instance has never reported a roster", () => {
    expect(listStrategies(db, "qkt-prod").every((s) => s.active)).toBe(true);
  });
  it("marks strategies in the latest roster active and the rest retired", () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "old_sleeve", type: "strategy.started", ts: 1717999999000,
        payload: { strategyId: "old_sleeve", ts: 1717999999000, sourcePath: "/srv/qkt/old.qkt", dslVersion: 1, runtimeMode: "paper", symbols: ["XAUUSD"] } }),
    ]);
    // A reshard leaves old_sleeve behind; the live roster is just latch.
    replaceRoster(db, "qkt-prod", ["latch"], 1718000100000);
    const byId = Object.fromEntries(listStrategies(db, "qkt-prod").map((s) => [s.strategyId, s.active]));
    expect(byId).toEqual({ latch: true, old_sleeve: false });
  });
  it("lets the newest roster supersede the previous one", () => {
    replaceRoster(db, "qkt-prod", ["someone_else"], 1718000100000);
    expect(listStrategies(db, "qkt-prod").find((s) => s.strategyId === "latch")!.active).toBe(false);
    replaceRoster(db, "qkt-prod", ["latch"], 1718000200000);
    expect(listStrategies(db, "qkt-prod").find((s) => s.strategyId === "latch")!.active).toBe(true);
  });
  it("ignores an empty roster so a momentary blank never wipes the live set", () => {
    replaceRoster(db, "qkt-prod", ["latch"], 1718000100000);
    replaceRoster(db, "qkt-prod", [], 1718000200000);
    expect(listStrategies(db, "qkt-prod").find((s) => s.strategyId === "latch")!.active).toBe(true);
  });
  it("lists orders filtered by instance and state", () => {
    const rows = listOrders(db, { instanceId: "qkt-prod", state: "FILLED", limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe("o1");
  });
  it("lists trades filtered by symbol", () => {
    const rows = listTrades(db, { instanceId: "qkt-prod", symbol: "XAUUSD", limit: 50 });
    expect(rows).toHaveLength(1);
  });
  it("full-text searches events scoped to instance", () => {
    const hits = searchEvents(db, { q: "XAUUSD", instanceId: "qkt-prod", limit: 50 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.instanceId === "qkt-prod")).toBe(true);
  });
  it("returns equity curve points ordered by ts", () => {
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "latch" });
    expect(pts).toEqual([{ ts: 1718000002000, equity: 1005, realized: 5, unrealized: 0 }]);
  });
  it("reports instance health with last seen, seq, and sink counters", () => {
    ingestEvents(db, "qkt-prod", [
      env({ id: "health-1", seq: 0, ts: 1718000003000, type: "insights.health",
        payload: { sent: 12, failed: 1, dropped: 2, queued: 3, queueCapacity: 100 } }),
    ]);
    const h = instanceHealth(db);
    const prod = h.find((x) => x.instanceId === "qkt-prod")!;
    expect(prod.lastSeq).toBeGreaterThanOrEqual(1);
    expect(prod.strategies).toBe(1);
    expect(prod.insightsSent).toBe(12);
    expect(prod.insightsFailed).toBe(1);
    expect(prod.insightsDropped).toBe(2);
    expect(prod.insightsQueued).toBe(3);
    expect(prod.insightsHealthTs).toBe(1718000003000);
  });

  it("downsamples a dense equity curve to real bucketed snapshots", () => {
    const T0 = 1718100000000;
    for (let batch = 0; batch < 3; batch++) {
      ingestEvents(db, "qkt-prod", Array.from({ length: 1000 }, (_, j) => {
        const i = batch * 1000 + j;
        return env({ strategyId: "dense", type: "snapshot.equity", ts: T0 + i * 5000,
          payload: { strategyId: "dense", realized: i, unrealized: 0, equity: 1000 + i, startingBalance: 1000 } });
      }));
    }
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "dense", points: 500 });
    expect(pts.length).toBeLessThanOrEqual(501);
    expect(pts.length).toBeGreaterThanOrEqual(400);
    // Endpoints survive: the newest snapshot is always the last bucket's last row.
    expect(pts[pts.length - 1]).toMatchObject({ ts: T0 + 2999 * 5000, equity: 3999 });
    // Every point is a stored row, never an interpolation.
    for (const p of pts) expect(p.equity - 1000).toBe((p.ts - T0) / 5000);
    // Order preserved.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.ts).toBeGreaterThan(pts[i - 1]!.ts);
  });

  it("returns the full curve when under the point budget", () => {
    const pts = equityCurve(db, { instanceId: "qkt-prod", strategyId: "latch", points: 1000 });
    expect(pts).toHaveLength(1);
  });

  it("does not grow strategy rows from log envelopes", () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch-deploy-name", type: "log", ts: 1718000003000,
        payload: { level: "INFO", logger: "com.qkt.x", message: "hello", ts: 1718000003000 } }),
    ]);
    expect(listStrategies(db, "qkt-prod").map((s) => s.strategyId)).toEqual(["latch"]);
  });

  it("queries current positions, risk events, and portfolio equity projections", () => {
    persistStateEvent(db, "qkt-prod", env({ id: "posn-1", type: "state.positions", ts: 1718000004000, payload: {
      broker: "EXNESS",
      positions: [{ ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, strategyId: "latch" }],
    } }));
    ingestEvents(db, "qkt-prod", [
      env({ id: "risk-1", strategyId: "latch", type: "risk.rejected", ts: 1718000005000,
        payload: { reason: "max-order", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 1 } }),
      env({ id: "port-1", type: "portfolio.equity.updated", ts: 1718000006000,
        payload: { portfolioId: "book", equity: 1010, realized: 10, unrealized: 0 } }),
    ]);

    expect(listCurrentPositions(db, { instanceId: "qkt-prod", strategyId: "latch" })[0])
      .toMatchObject({ broker: "EXNESS", ticket: "123", symbol: "EXNESS:XAUUSD", profit: 9.7 });
    expect(listRiskEvents(db, { instanceId: "qkt-prod", strategyId: "latch", limit: 10 })[0])
      .toMatchObject({ kind: "risk.rejected", reason: "max-order", symbol: "EXNESS:XAUUSD" });
    expect(listPortfolioEquity(db, { instanceId: "qkt-prod", portfolioId: "book", limit: 10 })[0])
      .toMatchObject({ portfolioId: "book", equity: 1010, realized: 10 });
  });
});

describe("deals and account equity", () => {
  const deal = (id: string, ts: number, opts: { strategyId?: string | null; entry?: string; profit?: number; commission?: number; swap?: number } = {}) =>
    env({ id, ts, type: "broker.deal", payload: {
      broker: "EXNESS", dealTicket: id.replace("deal-EXNESS-", ""), symbol: "EXNESS:XAUUSD", side: "SELL",
      entry: opts.entry ?? "OUT", qty: 0.01, price: 2310.2, profit: opts.profit ?? 9.7,
      commission: opts.commission ?? -0.07, swap: opts.swap ?? -0.12, ts,
      strategyId: opts.strategyId === undefined ? "hedge_straddle" : opts.strategyId } });

  it("listDeals returns newest first with strategy, limit, and before filters", () => {
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "hedge_straddle", type: "strategy.started", ts: 1718000000000,
        payload: { strategyId: "hedge_straddle", ts: 1718000000000 } }),
      deal("deal-EXNESS-1", 1718000001000, { entry: "IN" }),
      deal("deal-EXNESS-2", 1718000002000),
      deal("deal-EXNESS-3", 1718000003000),
    ]);
    const all = listDeals(db, { instanceId: "qkt-prod", limit: 50 });
    expect(all.map((d) => d.dealTicket)).toEqual(["3", "2", "1"]);
    expect(all[1]).toMatchObject({ broker: "EXNESS", symbol: "EXNESS:XAUUSD", side: "SELL",
      entry: "OUT", qty: 0.01, price: 2310.2, profit: 9.7, commission: -0.07, swap: -0.12,
      strategyId: "hedge_straddle", ts: 1718000002000 });
    expect(listDeals(db, { instanceId: "qkt-prod", strategyId: "hedge_straddle", limit: 50 })).toHaveLength(3);
    expect(listDeals(db, { instanceId: "qkt-prod", limit: 1 }).map((d) => d.dealTicket)).toEqual(["3"]);
    expect(listDeals(db, { instanceId: "qkt-prod", limit: 50, before: 1718000003000 }).map((d) => d.dealTicket)).toEqual(["2", "1"]);
  });

  it("accountEquity returns minute rows ascending within the range", () => {
    const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES (?,?,?,?,?,?)");
    ins.run("qkt-prod", "EXNESS", 1718000040000, 7824.05, 7676.54, -147.51);
    ins.run("qkt-prod", "EXNESS", 1718000100000, 7824.05, 7700.0, -124.05);
    ins.run("qkt-prod", "EXNESS", 1718000160000, 7824.05, 7650.0, -174.05);
    ins.run("other", "EXNESS", 1718000100000, 1, 1, 0);
    const all = accountEquity(db, { instanceId: "qkt-prod" });
    expect(all.map((r) => r.minuteTs)).toEqual([1718000040000, 1718000100000, 1718000160000]);
    expect(all[0]).toMatchObject({ broker: "EXNESS", balance: 7824.05, equity: 7676.54, openProfit: -147.51 });
    const ranged = accountEquity(db, { instanceId: "qkt-prod", from: 1718000100000, to: 1718000100000 });
    expect(ranged.map((r) => r.minuteTs)).toEqual([1718000100000]);
  });

  it("strategyStats computes trades, realized, and winRate from deals when out-deals exist", () => {
    ingestEvents(db, "qkt-prod", [
      deal("deal-EXNESS-10", 1718000001000, { strategyId: "latch", entry: "IN", profit: 0 }),
      deal("deal-EXNESS-11", 1718000002000, { strategyId: "latch", profit: 10, commission: -1, swap: -0.5 }),
      deal("deal-EXNESS-12", 1718000003000, { strategyId: "latch", profit: -5, commission: -1, swap: 0 }),
    ]);
    const s = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" });
    expect(s.tradeCount).toBe(2);
    expect(s.realizedPnl).toBeCloseTo(2.5);
    expect(s.winRate).toBeCloseTo(0.5);
  });

  it("strategyStats keeps the ledger behavior when the strategy has no deals", () => {
    const s = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" });
    expect(s.tradeCount).toBe(1);
    expect(s.realizedPnl).toBe(5);
  });

  it("listStrategies carries realized net and deal count from closing deals", () => {
    ingestEvents(db, "qkt-prod", [
      deal("deal-EXNESS-20", 1718000001000, { strategyId: "latch", entry: "IN", profit: 0 }),
      deal("deal-EXNESS-21", 1718000002000, { strategyId: "latch", profit: 10, commission: -1, swap: -0.5 }),
      deal("deal-EXNESS-22", 1718000003000, { strategyId: "latch", profit: -5, commission: -1, swap: 0 }),
    ]);
    const rows = listStrategies(db, "qkt-prod");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.realizedNet).toBeCloseTo(2.5);
    expect(rows[0]!.dealCount).toBe(2);
    // No deals on qkt-demo: aggregates are empty, not invented.
    const demo = listStrategies(db, "qkt-demo");
    expect(demo[0]!.realizedNet).toBeNull();
    expect(demo[0]!.dealCount).toBe(0);
  });

  it("strategyStats only trusts snapshot equity while snapshots are fresh", () => {
    const lastSnapTs = 1718000002000;
    const fresh = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" }, lastSnapTs + 60_000);
    expect(fresh.equity).toBe(1005);
    expect(fresh.startingBalance).toBe(1000);
    expect(fresh.returnPct).toBeCloseTo(0.005);
    const stale = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" }, lastSnapTs + 11 * 60_000);
    expect(stale.equity).toBeNull();
    expect(stale.startingBalance).toBeNull();
    expect(stale.returnPct).toBeNull();
    // Realized still flows from the ledger; only the frozen equity figures go dark.
    expect(stale.realizedPnl).toBe(5);
  });
});
