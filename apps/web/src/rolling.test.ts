import { describe, expect, it } from "vitest";
import { rollingCoverage } from "./rolling";

const point = (day: string, sharpe: number | null, winRate: number | null) => ({ day, sharpe, winRate, meanNet: winRate == null ? null : 1 });

describe("rolling coverage", () => {
  it("keeps both series when each has a value somewhere", () => {
    const c = rollingCoverage([point("2026-01-01", null, null), point("2026-01-02", 1.2, 50)], 30);
    expect(c).toEqual({ sharpe: true, winRate: true, notes: [] });
  });

  it("drops an all-null Sharpe and says how many days the window needs", () => {
    const c = rollingCoverage([point("2026-01-01", null, null), point("2026-01-02", null, 100), point("2026-01-03", null, 50)], 30);
    expect(c.sharpe).toBe(false);
    expect(c.winRate).toBe(true);
    expect(c.notes).toEqual(["Rolling Sharpe needs ≥ 30 trading days with closes in the window; this range has 2."]);
  });

  it("says a range of equity days without a single close has nothing to roll yet", () => {
    const c = rollingCoverage(Array.from({ length: 42 }, (_, i) => point(`2026-01-${String(i + 1).padStart(2, "0")}`, null, null)), 30);
    expect(c.sharpe).toBe(false);
    expect(c.winRate).toBe(false);
    expect(c.notes).toEqual(["No closed trades in this range yet: the rolling view starts with the first day that closes a trade."]);
  });
});
