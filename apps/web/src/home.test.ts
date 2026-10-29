import { describe, expect, it } from "vitest";
import type { AccountRiskRow, LivePositionRow } from "./api";
import { dailyMeasured, drawdownMeasured, emptyPeriods, floatingNote, floatingNoteText, limitLine, limitUse, noAccountMessage, openRisk, positionRisks, rangeFirstDay, riskRowFor, strategyLines, strategyPeriods, strategyTotal, todayHeadline, todaySplit, attentionItems } from "./home";

function position(p: Partial<LivePositionRow> & Pick<LivePositionRow, "ticket">): LivePositionRow {
  return { symbol: "XAUUSD", side: "BUY", qty: 1, entryPrice: 100, ...p };
}

function riskRow(p: Partial<AccountRiskRow> = {}): AccountRiskRow {
  return {
    account: "1@srv", label: "BRK", source: "account limits", basis: "peak", startBalance: 10_000, startBalanceSource: "configured",
    balance: 10_000, equity: 10_000, peakEquity: 10_500,
    drawdown: { used: 500, usedPct: 4.76, reference: 10_500, cap: 1_000 },
    dailyLoss: { used: 0, cap: 300, dayStart: 0, resetHour: 0, timezone: "UTC", includesFloating: false, dayStartBalance: 10_000, realizedToday: -120 },
    ...p,
  };
}

describe("positionRisks", () => {
  it("measures a short's stop above the price as a loss", () => {
    const r = positionRisks([position({ ticket: "s", side: "SELL", qty: 2, entryPrice: 100, currentPrice: 98, profit: 40, stopLoss: 101 })]).get("s")!;
    expect(r.valuePerUnit).toBeCloseTo(20, 9);
    expect(r.toStop).toBeCloseTo(-60, 9);
  });

  it("leaves a position at its entry with no priced sibling unpriced, and a zero stop as no stop", () => {
    const risks = openRisk([
      position({ ticket: "flat", currentPrice: 100, profit: 0, stopLoss: 95 }),
      position({ ticket: "nostop", symbol: "EURUSD", entryPrice: 1.1, currentPrice: 1.2, profit: 10, stopLoss: 0 }),
    ]);
    expect(risks).toMatchObject({ toStops: 0, priced: 0, noStop: 1, unpriced: 1 });
  });

  it("counts a locked-in stop past the entry as the move from the current price", () => {
    const r = positionRisks([position({ ticket: "l", currentPrice: 110, profit: 10, stopLoss: 105 })]).get("l")!;
    expect(r.toStop).toBeCloseTo(-5, 9);
  });
});

describe("limitUse", () => {
  it("raises the peak when live equity is above the stored one", () => {
    const use = limitUse(riskRow(), 10_600);
    expect(use.drawdown.used).toBe(0);
    expect(use.daily).toEqual({ used: 120, cap: 300, pct: 40, reference: 10_000, usedPct: 1.2 });
  });

  it("has no percentage without a cap", () => {
    const row = riskRow({ drawdown: { used: 500, usedPct: 4.76, reference: 10_500, cap: null } });
    expect(limitUse(row, 10_000).drawdown).toEqual({ used: 500, cap: null, pct: null, reference: 10_500, usedPct: (500 / 10_500) * 100 });
  });
});

describe("riskRowFor", () => {
  it("prefers the account id over the label", () => {
    const rows = [riskRow({ account: "mt5:2@srv", label: "BRK" }), riskRow({ account: "mt5:1@srv", label: "OLD" })];
    expect(riskRowFor({ broker: "BRK", accountId: "mt5:1@srv" }, rows)!.account).toBe("mt5:1@srv");
    expect(riskRowFor({ broker: "BRK" }, rows)!.account).toBe("mt5:2@srv");
  });
});

describe("strategyPeriods", () => {
  it("gives a strategy with only an open position a row, and ignores closes after now", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const rows = strategyPeriods(
      [{ strategyId: "a", ts: now + 1, realized: 99 }],
      { now, dayStart: Date.UTC(2026, 9, 21), floating: new Map([["b", -7]]) },
    );
    expect(rows.has("a")).toBe(false);
    expect(rows.get("b")).toMatchObject({ today: -7, all: 0, trades: 0, winRate: null, lastTs: null });
  });
});

describe("7D", () => {
  it("is today and the six UTC days before, in the strategy table as on the chart", () => {
    const now = Date.UTC(2026, 9, 21, 9);
    const first = Date.UTC(2026, 9, 15);
    const rows = strategyPeriods(
      [{ strategyId: "a", ts: first - 1, realized: 1000 }, { strategyId: "a", ts: first, realized: 0.1 }, { strategyId: "a", ts: now - 1, realized: 0.2 }],
      { now, dayStart: Date.UTC(2026, 9, 21) },
    );
    expect(rows.get("a")).toMatchObject({ d7: 0.3, all: 1000.3 });
    expect(rangeFirstDay("7d", now)).toBe(new Date(first).toISOString().slice(0, 10));
  });
});

describe("rangeFirstDay", () => {
  it("anchors each chip to UTC days", () => {
    const now = Date.UTC(2026, 9, 21, 23, 30);
    expect(rangeFirstDay("7d", now)).toBe("2026-10-15");
    expect(rangeFirstDay("mtd", now)).toBe("2026-10-01");
    expect(rangeFirstDay("ytd", now)).toBe("2026-01-01");
    expect(rangeFirstDay("all", now)).toBeNull();
  });
});

describe("strategyLines", () => {
  it("lists the roster, then retired strategies with closes, then unattributed, so the rows add up to the account", () => {
    const row = (id: string) => ({ strategyId: id, firstSeen: 0, lastSeen: 0, startingBalance: null, definedCapital: null, metadata: null, realizedNet: null, dealCount: 0, active: true });
    const periods = strategyPeriods(
      [{ strategyId: "a", ts: 1, realized: 5 }, { strategyId: "gone", ts: 2, realized: -2 }, { strategyId: null, ts: 3, realized: 1 }],
      { now: 10, dayStart: 0 },
    );
    const lines = strategyLines([row("a"), row("b")], periods);
    expect(lines.map((l) => [l.key, l.row?.strategyId ?? null, l.periods.all])).toEqual([["a", "a", 5], ["b", "b", 0], ["gone", null, -2], [null, null, 1]]);
    expect(lines[1]!.periods).toEqual(emptyPeriods("b"));
  });
});

describe("loss limits without a cap", () => {
  const noCaps = riskRow({
    source: null,
    drawdown: { used: 26_207.03, usedPct: 0.523, reference: 5_011_010.72, cap: null },
    peakEquity: 5_011_010.72,
    dailyLoss: { used: 612.37, cap: null, dayStart: 0, resetHour: 0, timezone: "UTC", includesFloating: false, dayStartBalance: 4_987_042.22, realizedToday: -612.37 },
  });

  it("still measures the day's loss and the drawdown below the peak", () => {
    const use = limitUse(noCaps, 4_984_803.69);
    expect(use.daily).toMatchObject({ used: 612.37, cap: null, pct: null });
    expect(use.drawdown.used).toBeCloseTo(26_207.03, 2);
    expect(use.drawdown.usedPct).toBeCloseTo(0.523, 3);
    expect(dailyMeasured(noCaps, use.daily)).toBe("lost today on closed trades");
    expect(drawdownMeasured(noCaps, use.drawdown)).toBe("26,207.03 below peak 5,011,010.72");
  });

  it("says when the day has no loss and equity sits at its reference", () => {
    const flat = riskRow({ basis: "static", dailyLoss: { ...noCaps.dailyLoss, used: 0, realizedToday: 40 } });
    const use = limitUse(flat, 10_200);
    expect(dailyMeasured(flat, use.daily)).toBe("no loss today: closed +40.00");
    expect(drawdownMeasured(flat, use.drawdown)).toBe("at or above start 10,000.00");
  });

  it("describes a floating-inclusive day from its day-start balance", () => {
    const floating = riskRow({ dailyLoss: { ...noCaps.dailyLoss, includesFloating: true, dayStartBalance: 10_000 } });
    expect(dailyMeasured(floating, limitUse(floating, 9_900).daily)).toBe("from the day-start balance 10,000.00 to equity now");
  });

  it("measures a higher-of day from the day-start equity when it was above the balance", () => {
    const higher = riskRow({
      dailyLoss: { ...noCaps.dailyLoss, includesFloating: true, base: "higher", dayStartBalance: 10_000, dayStartEquity: 10_400, reference: 10_400 },
    });
    const use = limitUse(higher, 10_100);
    expect(use.daily.used).toBe(300);
    expect(use.daily.reference).toBe(10_400);
    expect(dailyMeasured(higher, use.daily)).toBe("from the day-start equity 10,400.00 (above the balance) to equity now");
  });
});

describe("noAccountMessage", () => {
  it("waits for the first poll from a live instance, and names how long a silent one has been quiet", () => {
    const now = Date.now();
    expect(noAccountMessage("bench", now - 10_000, now)).toBe("Waiting for the first account update from qkt.");
    expect(noAccountMessage("bench", null, now)).toBe("Waiting for the first account update from qkt.");
    const quiet = noAccountMessage("bench", now - 3 * 86_400_000, now);
    expect(quiet).toMatch(/^bench last reported 3d ago \(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\)\. Its history is below\./);
  });
});

describe("limitLine", () => {
  const use = (used: number | null, cap: number | null) => ({ used, cap, pct: used != null && cap ? (used / cap) * 100 : null, reference: 50_000, usedPct: used != null ? (used / 50_000) * 100 : null });

  it("reads the limit beside the account figure: what is left and how much is used", () => {
    expect(limitLine(use(1_785.89, 5_000))).toEqual({ left: "3,214.11 left", used: "35.7% of the 5,000.00 limit used", over: false });
  });

  it("says over the limit once it is reached", () => {
    expect(limitLine(use(5_200, 5_000))).toEqual({ left: "over the 5,000.00 limit", used: "104.0% of the 5,000.00 limit used", over: true });
  });

  it("has nothing to say for an account without a limit", () => {
    expect(limitLine(use(1_785.89, null))).toBeNull();
  });
});


describe("floatingNote", () => {
  // the soak's Exness account: equity - balance is -584.39, the listed positions float +9.20, another bot the rest
  const account = { balance: 4_983_985.86, equity: 4_983_401.47 };
  const listed = [
    position({ ticket: "1", profit: 4.11, swap: 0 }),
    position({ ticket: "2", profit: 1.06, swap: 0 }),
    position({ ticket: "3", profit: 4.03, swap: 0 }),
  ];

  it("splits the account's floating into the listed positions and those outside the instance", () => {
    const n = floatingNote(account, listed, { count: 2, floating: -593.59 })!;
    expect(n.account).toBeCloseTo(-584.39, 6);
    expect(n.listed).toBeCloseTo(9.2, 9);
    expect(n.unmarked).toBe(0);
    expect(floatingNoteText(n)).toBe("\u2212593.59 on 2 trades from another system");
  });

  it("names listed positions the venue sends no mark for, never counting them as 0.00", () => {
    const paper = [position({ ticket: "p", profit: undefined, swap: undefined }), position({ ticket: "q", profit: 1.06, swap: 0 })];
    const n = floatingNote({ balance: 9_999.96, equity: 10_001.02 }, paper, null)!;
    expect(n).toMatchObject({ marked: 1, unmarked: 1, outside: null });
    expect(n.listed).toBeCloseTo(1.06, 9);
    expect(floatingNoteText(n)).toBe("1 trade with no price from the venue");
    expect(floatingNoteText(floatingNote(account, listed, { count: 1, floating: null })!)).toBe("1 trade from another system");
  });

  it("has nothing to say when every listed position is marked and the account floats what they float", () => {
    const matching = { balance: 4_983_985.86, equity: 4_983_985.86 + 9.21 };
    expect(floatingNote(matching, listed, null)).toBeNull();
    expect(floatingNote(matching, listed, { count: 0, floating: 0 })).toBeNull();
  });

  it("names floating on positions the instance is never told of, as the account minus the listed", () => {
    // the live soak: qkt reports only its own Exness position (+1.06); the account floats -1,149.76
    const n = floatingNote({ balance: 4_983_990.48, equity: 4_982_840.72 }, [position({ ticket: "e", profit: 1.06, swap: 0 })], null)!;
    expect(n.outside).toBeNull();
    expect(n.elsewhere).toBeCloseTo(-1_150.82, 2);
    expect(floatingNoteText(n)).toBe("\u22121,150.82 on trades not listed here");
    expect(floatingNote(account, listed, null)!.elsewhere).toBeCloseTo(-593.59, 2);
  });
});

describe("todaySplit", () => {
  it("splits an account's Today into qkt's closes and listed positions and another system's floating, adding to the account", () => {
    // the review's Exness tab: +16.93 closed, +1.42 on qkt's 2 listed positions, -767.77 on positions qkt does not list
    const account = { balance: 4_983_990.48, equity: 4_983_990.48 + 1.42 - 767.77 };
    const n = floatingNote(account, [position({ ticket: "a", profit: 1.0, swap: 0 }), position({ ticket: "b", profit: 0.42, swap: 0 })], null);
    const s = todaySplit(account, 16.93, n);
    expect(s).toEqual({ total: -749.42, qkt: 18.35, other: -767.77, unassigned: 0 });
  });

  it("is all qkt's when nothing floats outside the listed positions", () => {
    expect(todaySplit({ balance: 10_000, equity: 10_002.5 }, -1.25, null)).toEqual({ total: 1.25, qkt: 1.25, other: null, unassigned: 0 });
  });

  it("keeps what no part explains (a listed position without a mark) as unassigned, never as qkt's or the other system's", () => {
    const account = { balance: 9_999.96, equity: 10_001.02 };
    const n = floatingNote(account, [position({ ticket: "p", profit: undefined, swap: undefined }), position({ ticket: "q", profit: 1.06, swap: 0 })], null);
    expect(todaySplit(account, 0.5, n)).toEqual({ total: 1.56, qkt: 1.56, other: null, unassigned: 0 });
    // an outside position whose floating is unknown: the account's remainder stays unassigned
    const outside = floatingNote({ balance: 100, equity: 90 }, [position({ ticket: "r", profit: 2, swap: 0 })], { count: 1, floating: null })!;
    expect(todaySplit({ balance: 100, equity: 90 }, 0, outside)).toEqual({ total: -10, qkt: 2, other: null, unassigned: -12 });
    // a stopped account lists no positions: its last floating is not another system's
    const stopped = { balance: 9_999.96, equity: 10_001.85, stopped: true };
    expect(todaySplit(stopped, 0, floatingNote(stopped, [], null))).toEqual({ total: 1.89, qkt: 0, other: null, unassigned: 1.89 });
  });
});

describe("strategyTotal", () => {
  it("adds the rows and names what the account holds beyond them, so the total row adds up", () => {
    const split = { total: -749.42, qkt: 18.35, other: -767.77, unassigned: 0 };
    expect(strategyTotal([17.16, 0.85, 0.34], split)).toEqual({ rows: 18.35, other: -767.77, account: -749.42, rest: 0 });
    expect(strategyTotal([17.16, 0.85], split)).toEqual({ rows: 18.01, other: -767.77, account: -749.42, rest: 0.34 });
  });

  it("only sums the rows on All accounts", () => {
    expect(strategyTotal([1.1, 2.2, -0.3], null)).toEqual({ rows: 3, other: null, account: null, rest: 0 });
  });
});

describe("todayHeadline", () => {
  const split = (qkt: number, other: number | null = null) => ({ total: qkt + (other ?? 0), qkt, other, unassigned: 0 });

  it("sums qkt per currency and names each account's other-system floating", () => {
    const h = todayHeadline([
      { key: "x", name: "Exness •••2618", currency: "USD", split: split(18.35, -767.77) },
      { key: "a", name: "Paper A", currency: "USDC", split: split(0.5) },
      { key: "b", name: "Paper B", currency: "USDC", split: split(-0.54) },
    ]);
    expect(h.missing).toBe(0);
    expect(h.parts).toEqual([
      { kind: "qkt", value: 18.35, currency: "USD" },
      { kind: "qkt", value: -0.04, currency: "USDC" },
      { kind: "other", value: -767.77, currency: "USD", account: { key: "x", name: "Exness •••2618" } },
    ]);
  });

  it("leaves zero parts out, keeps one zero when there is nothing else, and counts accounts not known yet", () => {
    expect(todayHeadline([{ key: "a", name: "A", currency: "USDC", split: split(0) }, { key: "b", name: "B", currency: "USD", split: split(2) }]).parts)
      .toEqual([{ kind: "qkt", value: 2, currency: "USD" }]);
    expect(todayHeadline([{ key: "a", name: "A", currency: "USDC", split: split(0) }]).parts).toEqual([{ kind: "qkt", value: 0, currency: "USDC" }]);
    expect(todayHeadline([{ key: "a", name: "A", currency: "USDC", split: null }])).toEqual({ parts: [], missing: 1 });
  });
});

describe("attentionItems", () => {
  const strategy = (strategyId: string, extra: { active?: boolean; halted?: boolean } = {}) => ({ strategyId, name: strategyId, active: true, ...extra });
  const account = (key: string, extra: { stale?: boolean; stopped?: boolean } = {}) => ({ key, name: key, stale: false, lastSeen: 1, ...extra });

  it("lists halted strategies, quiet accounts and positions without a stop, in that order", () => {
    expect(attentionItems({
      strategies: [strategy("o04", { halted: true }), strategy("o11"), strategy("old", { active: false, halted: true })],
      accounts: [account("x"), account("a", { stale: true, stopped: true }), account("h", { stale: true })],
      noStop: 2,
    })).toEqual([
      { kind: "halted", strategyId: "o04", name: "o04" },
      { kind: "account", key: "a", name: "a", state: "stopped", since: 1 },
      { kind: "account", key: "h", name: "h", state: "stale", since: 1 },
      { kind: "no-stop", count: 2 },
    ]);
  });

  it("counts halted strategies past two, and is empty when nothing needs a look", () => {
    expect(attentionItems({ strategies: ["a", "b", "c"].map((id) => strategy(id, { halted: true })), accounts: [], noStop: 0 }))
      .toEqual([{ kind: "halted-many", count: 3 }]);
    expect(attentionItems({ strategies: [strategy("a")], accounts: [account("x")], noStop: 0 })).toEqual([]);
  });
});
