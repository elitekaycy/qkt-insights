import { describe, expect, it } from "vitest";
import type { AccountRiskRow, LivePositionRow } from "./api";
import { emptyPeriods, limitUse, openRisk, positionRisks, rangeFirstDay, riskRowFor, strategyLines, strategyPeriods } from "./home";

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
    expect(use.daily).toEqual({ used: 120, cap: 300, pct: 40 });
  });

  it("has no percentage without a cap", () => {
    const row = riskRow({ drawdown: { used: 500, usedPct: 4.76, reference: 10_500, cap: null } });
    expect(limitUse(row, 10_000).drawdown).toEqual({ used: 500, cap: null, pct: null });
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
