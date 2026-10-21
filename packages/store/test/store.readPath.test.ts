import { describe, it, expect } from "vitest";
import {
  openDb, ingestEnvelopes, ingestEvents, LiveStateStore, accountEquity, accountRisk, closedTrades, contributionRanking,
  costDecomposition, dailyNets, dataVersion, dowHourMatrix, drawdownPeriods, excursionStats, performanceReport,
  postLossStats, rollingStats, tradeBreakdowns, withAnalyticsScope, SNAPSHOT_HEARTBEAT_MS, type Db,
} from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 4, 11);
const F = { instanceId: "qkt-prod", strategyId: "gold" };

let seq = 0;
function deal(p: { ticket: string; position: string; entry: "IN" | "OUT"; ts: number; profit?: number; qty?: number; strategyId?: string }): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id: `deal-EXNESS-${p.ticket}`, seq: ++seq, ts: p.ts, type: "broker.deal",
    payload: {
      broker: "EXNESS", dealTicket: p.ticket, positionTicket: p.position, symbol: "EXNESS:XAUUSD",
      side: p.entry === "IN" ? "BUY" : "SELL", entry: p.entry, qty: p.qty ?? 0.01, price: 4300, profit: p.profit ?? 0,
      commission: -0.1, strategyId: p.strategyId ?? "gold", ts: p.ts,
    },
  } as Envelope;
}

function snapshot(ts: number, realized: number, id = `snap-${ts}`, strategyId = "paper"): Envelope {
  return {
    v: 1, instanceId: "qkt-prod", id, seq: ++seq, ts, type: "snapshot.equity",
    payload: { strategyId, realized, unrealized: 0, equity: 1000 + realized, startingBalance: 1000 },
  } as Envelope;
}

function seedTrades(db: Db): void {
  ingestEvents(db, "qkt-prod", [
    deal({ ticket: "1", position: "P1", entry: "IN", ts: T0 }),
    deal({ ticket: "2", position: "P1", entry: "OUT", ts: T0 + HOUR, profit: 12 }),
    deal({ ticket: "3", position: "P2", entry: "IN", ts: T0 + 2 * HOUR, qty: 0.02 }),
    deal({ ticket: "4", position: "P2", entry: "OUT", ts: T0 + 3 * HOUR, profit: -4 }),
    deal({ ticket: "5", position: "P2", entry: "OUT", ts: T0 + 26 * HOUR, profit: 7 }),
  ]);
}

function mark(db: Db, ticket: string, ts: number, profit: number | null): void {
  db.prepare(
    `INSERT INTO position_valuations (instance_id, broker, ticket, ts, symbol, side, qty, entry_price, current_price, profit, swap, strategy_id)
     VALUES ('qkt-prod','EXNESS',?,?,'EXNESS:XAUUSD','BUY',0.01,4300,4300,?,0,'gold')`,
  ).run(ticket, ts, profit);
}

describe("analytics scope", () => {
  it("gives every aggregate the same figures it computes alone", () => {
    const db = openDb(":memory:");
    seedTrades(db);
    const alone = {
      report: performanceReport(db, F), dailyNets: dailyNets(db, F), drawdownPeriods: drawdownPeriods(db, F),
      postLoss: postLossStats(db, F), breakdowns: tradeBreakdowns(db, F), closes: closedTrades(db, F),
      dowHour: dowHourMatrix(db, F), rolling: rollingStats(db, F), costs: costDecomposition(db, F),
      contribution: contributionRanking(db, F), excursions: excursionStats(db, F),
    };
    const scoped = withAnalyticsScope(db, () => ({
      report: performanceReport(db, F), dailyNets: dailyNets(db, F), drawdownPeriods: drawdownPeriods(db, F),
      postLoss: postLossStats(db, F), breakdowns: tradeBreakdowns(db, F), closes: closedTrades(db, F),
      dowHour: dowHourMatrix(db, F), rolling: rollingStats(db, F), costs: costDecomposition(db, F),
      contribution: contributionRanking(db, F), excursions: excursionStats(db, F),
    }));
    expect(scoped).toEqual(alone);
    expect(alone.closes).toHaveLength(3);
  });

  it("builds the closed-trade list once per scope, and each filter separately", () => {
    const db = openDb(":memory:");
    seedTrades(db);
    const prepare = db.prepare.bind(db);
    let closeQueries = 0;
    db.prepare = ((sql: string) => {
      if (sql.includes("FROM deals o")) closeQueries++;
      return prepare(sql);
    }) as Db["prepare"];
    withAnalyticsScope(db, () => {
      performanceReport(db, F);
      dailyNets(db, F);
      tradeBreakdowns(db, F);
      contributionRanking(db, F);
      dowHourMatrix(db, F);
    });
    expect(closeQueries).toBe(1);
    closeQueries = 0;
    withAnalyticsScope(db, () => {
      dailyNets(db, F);
      dailyNets(db, { ...F, from: T0 + 2 * HOUR });
    });
    expect(closeQueries).toBe(2);
  });

  it("hands out copies a caller may reorder without touching the shared list", () => {
    const db = openDb(":memory:");
    seedTrades(db);
    withAnalyticsScope(db, () => {
      const first = closedTrades(db, F);
      first.reverse();
      expect(closedTrades(db, F).map((c) => c.ts)).toEqual([T0 + 26 * HOUR, T0 + 3 * HOUR, T0 + HOUR]);
    });
  });

  it("sees writes made after the scope ends", () => {
    const db = openDb(":memory:");
    seedTrades(db);
    expect(withAnalyticsScope(db, () => closedTrades(db, F))).toHaveLength(3);
    ingestEvents(db, "qkt-prod", [
      deal({ ticket: "6", position: "P3", entry: "IN", ts: T0 + 30 * HOUR }),
      deal({ ticket: "7", position: "P3", entry: "OUT", ts: T0 + 31 * HOUR, profit: 1 }),
    ]);
    expect(withAnalyticsScope(db, () => closedTrades(db, F))).toHaveLength(4);
  });
});

describe("excursions in one query", () => {
  it("measures each partial close of one position over its own held window", () => {
    const db = openDb(":memory:");
    seedTrades(db);
    mark(db, "P2", T0 + 2 * HOUR + 1, -6);
    mark(db, "P2", T0 + 2 * HOUR + 2, 3);
    mark(db, "P2", T0 + 3 * HOUR + 1, 15);
    mark(db, "P2", T0 + 4 * HOUR, null);
    mark(db, "P1", T0 + 10, 2);
    const ex = excursionStats(db, F)!;
    expect(ex.rows.map((r) => ({ ts: r.ts, mae: r.mae, mfe: r.mfe, observations: r.observations }))).toEqual([
      { ts: T0 + HOUR, mae: 0, mfe: 2, observations: 1 },
      { ts: T0 + 3 * HOUR, mae: -6, mfe: 3, observations: 2 },
      { ts: T0 + 26 * HOUR, mae: -6, mfe: 15, observations: 3 },
    ]);
    expect(ex).toMatchObject({ closedTrades: 3, sampledTrades: 3, coveragePct: 100 });
  });
});

describe("snapshot.equity dedupe", () => {
  const count = (db: Db) => (db.prepare("SELECT COUNT(*) n FROM equity_snapshots WHERE strategy_id='paper'").get() as { n: number }).n;

  it("stores a change, skips repeats inside the heartbeat, and stores one per heartbeat", () => {
    const db = openDb(":memory:");
    const out = ingestEnvelopes(db, "qkt-prod", [
      snapshot(T0, 0), snapshot(T0 + 10_000, 0), snapshot(T0 + 20_000, 5), snapshot(T0 + 30_000, 5),
      snapshot(T0 + 20_000 + SNAPSHOT_HEARTBEAT_MS, 5),
    ]);
    expect(out.statuses).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
    expect(db.prepare("SELECT ts, realized FROM equity_snapshots ORDER BY ts").all()).toEqual([
      { ts: T0, realized: 0 }, { ts: T0 + 20_000, realized: 5 }, { ts: T0 + 20_000 + SNAPSHOT_HEARTBEAT_MS, realized: 5 },
    ]);
    expect(db.prepare("SELECT equity FROM strategies WHERE strategy_id='paper'").get()).toEqual({ equity: 1005 });
  });

  it("reports a redelivered snapshot as a duplicate and replays add nothing", () => {
    const db = openDb(":memory:");
    const batch = Array.from({ length: 50 }, (_, k) => snapshot(T0 + k * 10_000, k < 25 ? 0 : 3));
    ingestEnvelopes(db, "qkt-prod", batch);
    const stored = count(db);
    expect(stored).toBe(2);
    const again = ingestEnvelopes(db, "qkt-prod", batch);
    expect(again.accepted).toBe(48);
    expect(again.statuses.filter((s) => s === "duplicate")).toHaveLength(2);
    expect(count(db)).toBe(stored);
  });

  it("keeps a snapshot arriving late with a value its predecessor did not have", () => {
    const db = openDb(":memory:");
    ingestEnvelopes(db, "qkt-prod", [snapshot(T0, 0), snapshot(T0 + 60_000, 0)]);
    ingestEnvelopes(db, "qkt-prod", [snapshot(T0 + 30_000, 9)]);
    expect(db.prepare("SELECT ts, realized FROM equity_snapshots ORDER BY ts").all()).toEqual([
      { ts: T0, realized: 0 }, { ts: T0 + 30_000, realized: 9 },
    ]);
  });
});

describe("account equity sampling", () => {
  function seedMinutes(db: Db, n: number): void {
    const ins = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run("qkt-prod", i < n / 2 ? "ICM" : "ICMARKETS", T0 + i * 60_000, 1000, 1000 + i, i);
    })();
  }

  it("keeps the last stored minute of each bucket, at most `points` long", () => {
    const db = openDb(":memory:");
    seedMinutes(db, 5000);
    const full = accountEquity(db, { instanceId: "qkt-prod" });
    const sampled = accountEquity(db, { instanceId: "qkt-prod", points: 200 });
    expect(full).toHaveLength(5000);
    expect(sampled.length).toBeLessThanOrEqual(200);
    expect(sampled.length).toBeGreaterThan(150);
    const byMinute = new Map(full.map((p) => [`${p.broker}|${p.minuteTs}`, p]));
    for (const p of sampled) expect(byMinute.get(`${p.broker}|${p.minuteTs}`)).toEqual(p);
    expect(sampled[sampled.length - 1]).toEqual(full[full.length - 1]);
    expect([...sampled].sort((a, b) => a.minuteTs - b.minuteTs)).toEqual(sampled);
  });

  it("returns every minute when the range fits", () => {
    const db = openDb(":memory:");
    seedMinutes(db, 100);
    expect(accountEquity(db, { instanceId: "qkt-prod", points: 2000 })).toEqual(accountEquity(db, { instanceId: "qkt-prod" }));
  });

  it("serves account risk from the newest rollup minute", () => {
    const db = openDb(":memory:");
    const live = new LiveStateStore();
    const account = (ts: number, equity: number) => ({
      v: 1, instanceId: "qkt-prod", id: `acct-${ts}`, seq: 0, ts, type: "state.account",
      payload: { broker: "EXNESS", currency: "USD", balance: 1000, equity, login: "7", server: "Demo" },
    }) as Envelope;
    live.upsert("qkt-prod", account(T0, 990));
    live.flushRollup(db, T0 + 1000);
    const before = dataVersion(db, [{ account: "qkt-prod" }]);
    expect(accountRisk(db, { instanceId: "qkt-prod", now: T0 + 2000 })[0]).toMatchObject({ equity: 990 });
    live.upsert("qkt-prod", account(T0 + 60_000, 970));
    live.flushRollup(db, T0 + 61_000);
    expect(dataVersion(db, [{ account: "qkt-prod" }])).not.toBe(before);
    expect(accountRisk(db, { instanceId: "qkt-prod", now: T0 + 62_000 })[0]).toMatchObject({ equity: 970 });
  });
});

describe("data versions", () => {
  it("moves a strategy's version on its own money writes only", () => {
    const db = openDb(":memory:");
    const gold = dataVersion(db, [{ strategy: F }]);
    const other = dataVersion(db, [{ strategy: { instanceId: "qkt-prod", strategyId: "silver" } }]);
    ingestEvents(db, "qkt-prod", [deal({ ticket: "1", position: "P1", entry: "IN", ts: T0 })]);
    expect(dataVersion(db, [{ strategy: F }])).not.toBe(gold);
    expect(dataVersion(db, [{ strategy: { instanceId: "qkt-prod", strategyId: "silver" } }])).toBe(other);
    const afterDeal = dataVersion(db, [{ strategy: F }]);
    ingestEvents(db, "qkt-prod", [{ v: 1, instanceId: "qkt-prod", id: "log-1", seq: 1, ts: T0, type: "log",
      payload: { level: "INFO", logger: "x", message: "hello" } } as Envelope]);
    expect(dataVersion(db, [{ strategy: F }])).toBe(afterDeal);
  });
});
