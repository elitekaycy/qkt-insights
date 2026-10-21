import { describe, it, expect } from "vitest";
import { openDb, accountRisk, accountSeries, accountEquity, accountPerformance, monthBases, tradingDayStart, type Db } from "../src/index.js";

const I = "i1";
const M = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1, 6); // 2026-07-01 06:00Z

function equity(db: Db, broker: string, ts: number, balance: number, eq: number, account: string | null = null): void {
  db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,?,?)")
    .run(I, broker, ts, balance, eq, eq - balance, account);
}

function strategy(db: Db, id: string, risk: Record<string, unknown>): void {
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance, metadata) VALUES (?,?,?,?,?,?)")
    .run(I, id, T0, T0, risk.startingBalance ?? null, JSON.stringify({ risk }));
}

let ticket = 0;
function close(db: Db, ts: number, profit: number, strategyId: string | null = "s1"): void {
  const pos = `p${++ticket}`;
  const ins = db.prepare(
    `INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, strategy_id, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ins.run(`${pos}-in`, I, "B", `${pos}-in`, pos, "B:XAUUSD", "BUY", "IN", 0.1, 2000, 0, strategyId, ts - HOUR);
  ins.run(`${pos}-out`, I, "B", `${pos}-out`, pos, "B:XAUUSD", "SELL", "OUT", 0.1, 2000, profit, strategyId, ts);
}

describe("accountRisk", () => {
  it("derives caps from the account, never summing strategies that share it", () => {
    const db = openDb(":memory:");
    const risk = { startingBalance: 20_000, maxDailyLoss: 1_000, maxDailyDrawdownPct: 0.05, maxDrawdownPct: 0.1, totalDdBasis: "STATIC" };
    for (const id of ["a", "b", "c", "d", "e"]) strategy(db, id, risk);
    equity(db, "BRK", T0 - 2 * HOUR, 20_000, 20_000);
    equity(db, "BRK", T0 - HOUR, 18_500, 18_400);
    close(db, T0 - 30 * M, -300, "a");
    const [row] = accountRisk(db, { instanceId: I, now: T0 });
    expect(row!.source).toBe("strategy risk config");
    expect(row!.basis).toBe("static");
    expect(row!.startBalance).toBe(20_000);
    // 5 strategies x 1,000 / 2,000 would be the summed (wrong) caps
    expect(row!.dailyLoss.cap).toBe(1_000);
    expect(row!.drawdown.cap).toBe(2_000);
    // static: start balance minus equity, not balance minus equity (100)
    expect(row!.drawdown.used).toBe(1_600);
    expect(row!.drawdown.usedPct).toBeCloseTo(8, 9);
    expect(row!.dailyLoss.used).toBe(300);
    expect(row!.dailyLoss.realizedToday).toBe(-300);
  });

  it("defaults to drawdown from the equity peak", () => {
    const db = openDb(":memory:");
    equity(db, "BRK", T0 - 3 * HOUR, 10_000, 10_000);
    equity(db, "BRK", T0 - 2 * HOUR, 10_400, 10_600);
    equity(db, "BRK", T0 - HOUR, 10_300, 10_250);
    const [row] = accountRisk(db, { instanceId: I, now: T0, limits: { "*": { maxDrawdownPct: 10, dailyLoss: 400 } } });
    expect(row!.source).toBe("account limits");
    expect(row!.basis).toBe("peak");
    expect(row!.peakEquity).toBe(10_600);
    expect(row!.drawdown.used).toBe(350);
    expect(row!.drawdown.reference).toBe(10_600);
    // start balance falls back to the first recorded balance; cap = 10% of it
    expect(row!.startBalanceSource).toBe("first recorded balance");
    expect(row!.drawdown.cap).toBe(1_000);
    expect(row!.dailyLoss.cap).toBe(400);
    expect(row!.dailyLoss.used).toBe(0);
  });

  it("applies a configured static, server-day, floating-inclusive profile by login@server", () => {
    const db = openDb(":memory:");
    // Server day (UTC+3 in July) began 2026-06-30 21:00Z; the realized close at 20:30Z belongs to the previous day.
    equity(db, "PROP_S01", Date.UTC(2026, 5, 30, 20), 49_000, 49_000, "777@Demo-Server");
    equity(db, "PROP", Date.UTC(2026, 5, 30, 21), 48_800, 48_800, "777@Demo-Server");
    equity(db, "PROP", T0 - M, 48_800, 48_300, "777@Demo-Server");
    close(db, Date.UTC(2026, 5, 30, 20, 30), -200);
    const limits = { "777@Demo-Server": { basis: "static" as const, startBalance: 50_000, dailyLossPct: 5, maxDrawdownPct: 10, timezone: "Europe/Athens", dailyLossIncludesFloating: true } };
    const rows = accountRisk(db, { instanceId: I, now: T0, limits });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.account).toBe("777@Demo-Server");
    expect(row.dailyLoss.dayStart).toBe(Date.UTC(2026, 5, 30, 21));
    expect(row.dailyLoss.dayStartBalance).toBe(48_800);
    expect(row.dailyLoss.used).toBe(500); // floating included
    expect(row.dailyLoss.realizedToday).toBe(0);
    expect(row.dailyLoss.cap).toBeCloseTo(2_440, 9);
    expect(row.drawdown.used).toBe(1_700);
    expect(row.drawdown.cap).toBe(5_000);
  });
});

describe("tradingDayStart", () => {
  it("resets at the configured hour in the configured timezone", () => {
    const noon = Date.UTC(2026, 6, 1, 12);
    expect(tradingDayStart(noon)).toBe(Date.UTC(2026, 6, 1));
    expect(tradingDayStart(noon, 22)).toBe(Date.UTC(2026, 5, 30, 22));
    expect(tradingDayStart(noon, 0, "Europe/Athens")).toBe(Date.UTC(2026, 5, 30, 21));
    // winter: UTC+2
    expect(tradingDayStart(Date.UTC(2026, 0, 15, 12), 0, "Europe/Athens")).toBe(Date.UTC(2026, 0, 14, 22));
  });
});

describe("accountSeries", () => {
  it("stitches relabels of one account into one series, keeps concurrent accounts apart", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) equity(db, "ICM", T0 + i * M, 100, 100);
    for (let i = 10; i < 20; i++) equity(db, "ICMARKETS", T0 + i * M, 101, 101, "1@S");
    for (let i = 0; i < 20; i++) equity(db, "OTHER", T0 + i * M, 500, 500, "2@S");
    const s = accountSeries(db, { instanceId: I });
    expect(s.map((a) => [a.key, a.labels.sort(), a.points.length]).sort()).toEqual([["1@S", ["ICM", "ICMARKETS"], 20], ["2@S", ["OTHER"], 20]]);
    const pts = accountEquity(db, { instanceId: I });
    expect(new Set(pts.map((p) => p.account))).toEqual(new Set(["1@S", "2@S"]));
    expect(pts.filter((p) => p.broker === "ICM").every((p) => p.account === "1@S")).toBe(true);
  });
});

describe("monthBases", () => {
  it("measures each month against the account's equity when it began, not summed strategy allocations", () => {
    const db = openDb(":memory:");
    for (const id of ["a", "b", "c"]) strategy(db, id, { startingBalance: 20_000, maxDrawdownPct: 0.1 });
    equity(db, "BRK", Date.UTC(2026, 6, 3), 20_000, 20_000); // first record mid-July
    equity(db, "BRK", Date.UTC(2026, 6, 31, 23, 59), 21_000, 21_200);
    equity(db, "BRK", Date.UTC(2026, 7, 2), 21_200, 21_100);
    expect(monthBases(db, { instanceId: I, months: ["2026-07", "2026-08"] })).toEqual([
      { period: "2026-07", base: 20_000, source: "account equity" },
      { period: "2026-08", base: 21_200, source: "account equity" },
    ]);
    close(db, Date.UTC(2026, 7, 5), 424, "a");
    const perf = accountPerformance(db, { instanceId: I });
    expect(perf.monthBases).toEqual([{ period: "2026-08", base: 21_200, source: "account equity" }]);
    expect((perf.totalNet / perf.monthBases[0]!.base) * 100).toBeCloseTo(2, 9);
  });

  it("falls back to the de-duplicated start balance without account history", () => {
    const db = openDb(":memory:");
    for (const id of ["a", "b"]) strategy(db, id, { startingBalance: 20_000 });
    expect(monthBases(db, { instanceId: I, months: ["2026-07"] })).toEqual([{ period: "2026-07", base: 20_000, source: "start balance" }]);
  });
});

describe("account identity in the rollup", () => {
  it("records the account id (inferred from login@server when not stated) so relabels of one account stitch", async () => {
    const { LiveStateStore } = await import("../src/index.js");
    const db = openDb(":memory:");
    const live = new LiveStateStore();
    live.upsert(I, { v: 1, instanceId: I, id: "a1", seq: 1, ts: T0, type: "state.account",
      payload: { broker: "BRK_S01", currency: "USD", balance: 1000, equity: 990, login: "42", server: "Demo-1" } } as never);
    live.flushRollup(db, T0 + 1000);
    expect(db.prepare("SELECT broker, account FROM account_equity").all()).toEqual([{ broker: "BRK", account: "mt5:42@Demo-1" }]);
  });

  it("records a stated account id and label as they are", async () => {
    const { LiveStateStore } = await import("../src/index.js");
    const db = openDb(":memory:");
    const live = new LiveStateStore();
    live.upsert(I, { v: 1, instanceId: I, id: "a1", seq: 1, ts: T0, type: "state.account",
      payload: { broker: "PAPER_DERIBIT", currency: "USDC", balance: 1000, equity: 990, login: "paper",
        venue: { connector: "vgp", adapter: "paper", label: "PAPER_DERIBIT" }, accountId: "vgp:paper:paper" } } as never);
    live.flushRollup(db, T0 + 1000);
    expect(db.prepare("SELECT broker, account FROM account_equity").all()).toEqual([{ broker: "PAPER_DERIBIT", account: "vgp:paper:paper" }]);
  });
});
