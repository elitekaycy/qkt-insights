import { describe, expect, it } from "vitest";
import type { StrategyRow } from "./api";
import { emptyPeriods } from "./home";
import { cardFigures, isFolded, mergeCurves, realizedCurves, sortCards, sparkPath, thinCurve, type CardLine } from "./strategyCards";

const row = (strategyId: string, extra: Partial<StrategyRow> = {}): StrategyRow =>
  ({ strategyId, metadata: null, active: true, halted: false, definedCapital: null, startingBalance: null, ...extra }) as StrategyRow;
const line = (key: string | null, p: Partial<ReturnType<typeof emptyPeriods>> = {}, r: StrategyRow | null = key ? row(key) : null): CardLine =>
  ({ key, row: r, periods: { ...emptyPeriods(key), ...p } });

describe("cardFigures", () => {
  it("nets realized and open P&L and takes the return base from the strategy's capital", () => {
    const f = cardFigures(line("a", { all: 100.1, floating: -0.2, trades: 3, winRate: 0.5 }, row("a", { definedCapital: 5_000 })));
    expect(f.net).toBe(99.9);
    expect(f.base).toBe(5_000);
    expect(f.baseSource).toBe("defined");
  });
});

describe("sortCards", () => {
  const lines = [
    line("b", { all: 10, today: 5, lastTs: 3 }),
    line(null, { all: 999 }),
    line("a", { all: 50, floating: -45, today: 1, lastTs: 9 }),
    line("c", { all: -5, today: 7, lastTs: null }),
  ];
  it("orders by net, today, newest close or name, the unattributed bucket last", () => {
    expect(sortCards(lines, "net").map((l) => l.key)).toEqual(["b", "a", "c", null]);
    expect(sortCards(lines, "today").map((l) => l.key)).toEqual(["c", "b", "a", null]);
    expect(sortCards(lines, "last").map((l) => l.key)).toEqual(["a", "b", "c", null]);
    expect(sortCards(lines, "name").map((l) => l.key)).toEqual(["a", "b", "c", null]);
  });
});

describe("isFolded", () => {
  it("folds retired strategies and ones that never traded nor hold a position", () => {
    expect(isFolded(line("a", { trades: 1 }, row("a", { active: false })))).toBe(true);
    expect(isFolded(line("a"))).toBe(true);
    expect(isFolded(line("a", { floating: 3 }))).toBe(false);
    expect(isFolded(line(null))).toBe(false);
  });
});

describe("curves", () => {
  const closes = [
    { strategyId: "a", ts: 2, realized: 10 },
    { strategyId: "b", ts: 1, realized: -4 },
    { strategyId: "a", ts: 3, realized: -2.5 },
    { strategyId: "a", ts: 99, realized: 1 },
  ];
  it("accumulates each strategy's closes in time order from zero, up to now", () => {
    const c = realizedCurves(closes, { now: 10 });
    expect(c.get("a")).toEqual([0, 10, 7.5]);
    expect(c.get("b")).toEqual([0, -4]);
    expect(mergeCurves(closes, new Set(["a", "b"]), { now: 10 })).toEqual([0, -4, 6, 3.5]);
  });

  it("thins long curves to real points, keeping the extremes and both ends", () => {
    const points = Array.from({ length: 1_000 }, (_, i) => Math.sin(i / 20) * 100 + (i === 517 ? 500 : 0));
    const thin = thinCurve(points, 120);
    expect(thin.length).toBeLessThanOrEqual(120);
    expect(thin[0]).toBe(points[0]);
    expect(thin.at(-1)).toBe(points.at(-1));
    expect(Math.max(...thin)).toBe(Math.max(...points));
    expect(Math.min(...thin)).toBe(Math.min(...points));
    for (const p of thin) expect(points).toContain(p);
  });

  it("draws a dashed zero only when the curve crosses it", () => {
    expect(sparkPath([0], 100, 40)).toBeNull();
    expect(sparkPath([0, 5, 10], 100, 40)!.zeroY).toBeNull();
    expect(sparkPath([0, -10, 10], 100, 40)!.zeroY).toBe(20);
  });
});
