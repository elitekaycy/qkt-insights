import { describe, it, expect, beforeEach } from "vitest";
import { openDb, ingestEvents, listLogs, listTrades, strategyStats, type Db } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

function env(p: any): Envelope {
  return { v: 1, instanceId: "qkt-prod", id: Math.random().toString(36).slice(2), seq: p.seq ?? 1, ts: p.ts ?? 1718000000000, ...p } as Envelope;
}

function logEnv(p: { level?: string; logger?: string; message: string; strategyId?: string; ts?: number }): Envelope {
  const extra: any = {
    type: "log",
    payload: { level: p.level ?? "INFO", logger: p.logger ?? "com.qkt.app.LiveSession", message: p.message },
  };
  if (p.strategyId !== undefined) extra.strategyId = p.strategyId;
  if (p.ts !== undefined) extra.ts = p.ts;
  return env(extra);
}

describe("log ingestion", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      logEnv({ message: "engine started", strategyId: "latch" }),
      logEnv({ level: "WARN", message: "stale symbol XAUUSD detected", strategyId: "latch" }),
      logEnv({ level: "ERROR", logger: "com.qkt.broker.mt5.MT5Broker", message: "order rejected by venue" }),
    ]);
  });

  it("routes log envelopes to the logs table, not events", () => {
    expect(db.prepare("SELECT COUNT(*) c FROM logs").get()).toMatchObject({ c: 3 });
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toMatchObject({ c: 0 });
  });

  it("filters by level and strategy", () => {
    expect(listLogs(db, { instanceId: "qkt-prod", level: "WARN", limit: 50 })).toHaveLength(1);
    expect(listLogs(db, { instanceId: "qkt-prod", strategyId: "latch", limit: 50 })).toHaveLength(2);
  });

  it("full-text searches log messages", () => {
    const hits = listLogs(db, { instanceId: "qkt-prod", q: "XAUUSD", limit: 50 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.level).toBe("WARN");
  });

  it("is idempotent on duplicate log ids", () => {
    const e = logEnv({ message: "dup" });
    ingestEvents(db, "qkt-prod", [e]);
    ingestEvents(db, "qkt-prod", [e]);
    expect(db.prepare("SELECT COUNT(*) c FROM logs WHERE message='dup'").get()).toMatchObject({ c: 1 });
  });
});

describe("trade strategy attribution", () => {
  it("attributes a strategy-less trade through its order", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ seq: 1, strategyId: "latch", type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 1 } }),
      env({ seq: 2, type: "trade", payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350, qty: 1, ts: 1718000000000 } }),
    ]);
    const rows = listTrades(db, { instanceId: "qkt-prod", limit: 10 });
    expect(rows[0]!.strategyId).toBe("latch");
    expect(listTrades(db, { instanceId: "qkt-prod", strategyId: "latch", limit: 10 })).toHaveLength(1);
  });
});

describe("strategyStats", () => {
  const DAY = 86_400_000;
  const t0 = 1718000000000;

  it("computes counts, winRate, drawdown and sharpe from fixtures", () => {
    const db = openDb(":memory:");
    const events: Envelope[] = [
      env({ seq: 1, strategyId: "latch", type: "order.submit", payload: { orderId: "o1", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 1 } }),
      env({ seq: 2, type: "trade", ts: t0, payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 100, qty: 1, ts: t0 } }),
      env({ seq: 3, type: "trade", ts: t0 + 1000, payload: { orderId: "o1", symbol: "XAUUSD", side: "SELL", price: 110, qty: 1, ts: t0 + 1000 } }),
    ];
    // Six daily equity snapshots: 1000 -> 1100 -> 1050 -> 1150 -> 1100 -> 1200.
    // Realized series: closes at +100 (win), -50 (loss), +100 (win), -50 (loss), +100 (win).
    const eq = [1000, 1100, 1050, 1150, 1100, 1200];
    const realized = [0, 100, 50, 150, 100, 200];
    eq.forEach((e_, i) => {
      events.push(env({ strategyId: "latch", ts: t0 + i * DAY, type: "snapshot.equity",
        payload: { strategyId: "latch", realized: realized[i], unrealized: 0, equity: e_, startingBalance: 1000 } }));
    });
    ingestEvents(db, "qkt-prod", events);

    const s = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" }, t0 + 5 * DAY + 60_000);
    expect(s.tradeCount).toBe(2);
    expect(s.buyCount).toBe(1);
    expect(s.sellCount).toBe(1);
    expect(s.volume).toBe(2);
    expect(s.realizedPnl).toBe(200);
    expect(s.equity).toBe(1200);
    expect(s.startingBalance).toBe(1000);
    expect(s.returnPct).toBeCloseTo(0.2);
    expect(s.winRate).toBeCloseTo(3 / 5);
    // Peaks 1100 -> trough 1050 (4.545%), peak 1150 -> trough 1100 (4.348%): max is 1050/1100.
    expect(s.maxDrawdownPct).toBeCloseTo(50 / 1100);
    // Daily returns: .1, -.0455, .0952, -.0435, .0909 -> mean/std * sqrt(252)
    const rets = [0.1, 1050 / 1100 - 1, 1150 / 1050 - 1, 1100 / 1150 - 1, 1200 / 1100 - 1];
    const mean = rets.reduce((a, b) => a + b) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    expect(s.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(252), 5);
  });

  it("returns nulls (not fake numbers) when there is too little data", () => {
    const db = openDb(":memory:");
    ingestEvents(db, "qkt-prod", [
      env({ strategyId: "latch", type: "snapshot.equity", payload: { strategyId: "latch", realized: 0, unrealized: 0, equity: 1000, startingBalance: 1000 } }),
    ]);
    const s = strategyStats(db, { instanceId: "qkt-prod", strategyId: "latch" });
    expect(s.sharpe).toBeNull();
    expect(s.winRate).toBeNull();
    expect(s.tradeCount).toBe(0);
  });
});
