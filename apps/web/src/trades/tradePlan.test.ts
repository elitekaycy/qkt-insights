import { describe, it, expect } from "vitest";
import type { PositionPath } from "./data";
import { movePct, planFigures, PLACEHOLDER_RR, stopStyleWords } from "./tradePlan";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 8);

/** A long XAUUSD at 2000 (100 per price unit): stop 1990, target 2030; latest 2012, best 2020 (+2000), worst 1995. */
function path(over: Partial<PositionPath> = {}): PositionPath {
  return {
    ticket: "P1", status: "open", side: "long",
    entry: { ts: T0, price: 2000 }, exit: null,
    stopPrice: 1990, targetPrice: 2030, levelSource: "order", levelSteps: [], stopStyle: null, partials: [], moneyPerPoint: 100, riskAmount: null,
    bucketMs: 5 * M, buckets: [5 * M],
    candles: [{ t: T0, o: 2000, h: 2020, l: 1995, c: 2012, marks: 4 }],
    pnl: [],
    best: { ts: T0 + 10 * M, price: 2020, pnl: 2000 },
    worst: { ts: T0 + 3 * M, price: 1995, pnl: -500 },
    last: { ts: T0 + 20 * M, price: 2012, pnl: 1200, swap: 0 },
    marks: 4, firstMarkTs: T0 + M, longestGap: null, gapSpans: [], flatSpans: [], gaps: 0,
    ...over,
  };
}

describe("planFigures, open trade", () => {
  it("measures the room to the stop and the target from the price now, and what each pays from the entry", () => {
    const f = planFigures(path(), null)!;
    expect(f.toStop).toEqual({ points: 22, pct: (22 / 2012) * 100, money: -1000 });
    expect(f.toTarget).toEqual({ points: 18, pct: (18 / 2012) * 100, money: 3000 });
    expect(f.riskMoney).toBe(-1000);
    expect(f.rewardMoney).toBe(3000);
    expect(f.rewardRisk).toBe(3);
    // 0 at the stop, 1 at the target: entry at 10/40, now at 22/40, best at 30/40
    expect(f.scale).toEqual({ entry: 0.25, at: 0.55, best: 0.75 });
    expect(f.bestToTarget).toEqual({ points: 10, pct: (10 / 2030) * 100 });
    expect(f.kept).toBeNull();
  });

  it("mirrors every distance for a short", () => {
    const f = planFigures(path({
      side: "short", stopPrice: 2010, targetPrice: 1970,
      best: { ts: T0 + M, price: 1980, pnl: 2000 }, last: { ts: T0 + 2 * M, price: 1990, pnl: 1000, swap: 0 },
    }), null)!;
    expect(f.toStop!.points).toBe(20);
    expect(f.toStop!.money).toBe(-1000);
    expect(f.toTarget!.points).toBe(20);
    expect(f.toTarget!.money).toBe(3000);
    expect(f.scale).toEqual({ entry: 0.25, at: 0.5, best: 0.75 });
    expect(f.bestToTarget!.points).toBe(10);
  });

  it("prefers the engine's stated risk money over the price rate", () => {
    expect(planFigures(path({ riskAmount: 987.5 }), null)!.riskMoney).toBe(-987.5);
  });

  it("follows the venue's latest stop once it trailed, keeping the risk and the scale on the initial stop", () => {
    const f = planFigures(path({ levelSteps: [
      { ts: T0, stop: 1990, target: 2030 }, { ts: T0 + 5 * M, stop: 2000, target: 2030 }, { ts: T0 + 9 * M, stop: 2005, target: 2030 },
    ] }), null)!;
    expect(f.stop).toBe(2005);
    expect(f.initialStop).toBe(1990);
    expect(f.stopMoves).toBe(2);
    expect(f.toStop!.points).toBe(7);
    expect(f.toStop!.money).toBe(500); // the trailed stop now locks in profit
    expect(f.riskMoney).toBe(-1000);
    expect(f.scale!.entry).toBe(0.25);
  });

  it("treats a target far beyond reach as a placeholder, not the end of the bar", () => {
    const f = planFigures(path({ targetPrice: 2000 + 10 * PLACEHOLDER_RR }), null)!;
    expect(f.target).toBeNull();
    expect(f.placeholderTarget).toBe(2200);
    expect(f.scale).toBeNull();
    expect(f.toTarget).toBeNull();
    expect(f.toStop!.points).toBe(22);
    expect(f.rewardRisk).toBeNull();
  });

  it("says nothing it cannot know: no stop, no target, no rate", () => {
    const f = planFigures(path({ stopPrice: null, targetPrice: null, moneyPerPoint: null }), null)!;
    expect(f.stop).toBeNull();
    expect(f.target).toBeNull();
    expect(f.scale).toBeNull();
    expect(f.toStop).toBeNull();
    expect(f.riskMoney).toBeNull();
    expect(planFigures(path({ entry: null }), null)).toBeNull();
  });
});

describe("planFigures, closed trade", () => {
  const closed = (over: Partial<PositionPath> = {}) => path({ status: "closed", exit: { ts: T0 + 30 * M, price: 2014 }, ...over });

  it("places the exit on the scale and keeps the share of the best profit it banked", () => {
    const f = planFigures(closed(), 1400)!;
    expect(f.at).toEqual({ kind: "exit", price: 2014, ts: T0 + 30 * M });
    expect(f.scale!.at).toBe(0.6);
    expect(f.kept).toBe(0.7);
    expect(f.toStop).toBeNull();
    expect(f.toTarget).toBeNull();
  });

  it("shows no kept share when the exit beat every mark", () => {
    expect(planFigures(closed(), 2600)!.kept).toBeNull();
  });

  it("clamps the kept share at 0 when the exit gave back more than the best", () => {
    expect(planFigures(closed(), -300)!.kept).toBe(0);
    expect(planFigures(closed({ best: { ts: T0, price: 1999, pnl: -100 } }), -300)!.kept).toBeNull();
  });
});

describe("movePct and stopStyleWords", () => {
  it("signs the price move for the side", () => {
    expect(movePct("long", 2000, 2010)).toBeCloseTo(0.5, 10);
    expect(movePct("short", 2000, 2010)).toBeCloseTo(-0.5, 10);
    expect(movePct("long", null, 2010)).toBeNull();
  });

  it("names a moving stop and stays quiet for a fixed one", () => {
    const fmt = (v: number) => v.toFixed(2);
    const every = (ms: number) => `${ms / 3_600_000}h`;
    expect(stopStyleWords({ kind: "trailing", trailDistance: 5, armAt: 10 }, fmt, every)).toBe("Trailing stop · trails 5.00 · once 10.00 in profit");
    expect(stopStyleWords({ kind: "stepped", steps: 2, armAt: 4 }, fmt, every)).toBe("Stepped stop · 2 steps · first at 4.00 in profit");
    expect(stopStyleWords({ kind: "tightening", intervalMs: 3_600_000 }, fmt, every)).toBe("Tightening stop · moves every 1h");
    expect(stopStyleWords({ kind: "fixed" }, fmt, every)).toBeNull();
    expect(stopStyleWords(null, fmt, every)).toBeNull();
  });
});
