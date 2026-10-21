import { describe, expect, it } from "vitest";
import { rangeStart } from "../components/ui";
import { chipOf, exitSpan, nearestByTime, pickedSpan, profitFactorText, toggleToken, windowTotals, withCumulative, without } from "./journal";

const day = (d: string, n: number, wins: number, losses: number, pnl: number) => ({ day: d, n, wins, losses, pnl });

describe("click to filter", () => {
  it("adds a token, replaces the same key, and clears it on the second click", () => {
    expect(toggleToken("", "side:long")).toBe("side:long");
    expect(toggleToken("win side:long", "side:short")).toBe("win side:short");
    expect(toggleToken("win side:long", "side:long")).toBe("win");
    expect(toggleToken("exit:2026-10-21", "exit:2026-10-21")).toBe("");
    expect(toggleToken("held:>=1d", "held:1h..4h")).toBe("held:1h..4h");
  });

  it("reads the picked exit day or month, and drops keys a section keeps whole", () => {
    expect(pickedSpan("win exit:2026-10-21")).toEqual({ day: "2026-10-21", month: "2026-10" });
    expect(pickedSpan("exit:2026-10")).toEqual({ day: null, month: "2026-10" });
    expect(pickedSpan("exit:7d")).toEqual({ day: null, month: null });
    expect(without("win exit:2026-10-21 side:long", ["exit"])).toBe("win side:long");
    expect(chipOf("pnl:<0 weekday:monday", "weekday")).toBe("weekday:mon");
  });

  it("names the exit days of a drawdown", () => {
    expect(exitSpan(Date.UTC(2026, 9, 2, 10), Date.UTC(2026, 9, 9, 23))).toBe("exit:2026-10-02..2026-10-09");
    expect(exitSpan(Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 2, 22))).toBe("exit:2026-10-02");
  });
});

describe("window sums", () => {
  const days = [day("2026-10-01", 2, 1, 1, 10), day("2026-10-02", 1, 0, 1, -5), day("2026-10-05", 3, 3, 0, 30), day("2026-10-06", 1, 0, 0, 0)];

  it("sum exactly the days a zoomed chart shows", () => {
    expect(windowTotals(days, null)).toMatchObject({ from: "2026-10-01", to: "2026-10-06", days: 4, trades: 7, pnl: 35, wins: 4, losses: 2 });
    expect(windowTotals(days, { start: 33.4, end: 66.6 })).toMatchObject({ from: "2026-10-02", to: "2026-10-05", days: 2, trades: 4, pnl: 25, winRate: 75 });
    expect(windowTotals(days, { start: 100, end: 100 })).toMatchObject({ from: "2026-10-06", days: 1, winRate: null });
    expect(windowTotals([], null)).toBeNull();
  });

  it("run a cumulative total and pick the nearest trade", () => {
    expect(withCumulative(days).map((d) => d.cum)).toEqual([10, 5, 35, 35]);
    const trades = [{ exitTs: 10 }, { exitTs: 20 }, { exitTs: 40 }];
    expect(nearestByTime(trades, 33)).toBe(trades[2]);
    expect(nearestByTime([], 1)).toBeNull();
  });
});

describe("formats and ranges", () => {
  it("prints the profit factor and starts calendar ranges at a UTC midnight", () => {
    expect([profitFactorText("inf"), profitFactorText(null), profitFactorText(1.234)]).toEqual(["∞", "—", "1.23"]);
    const now = Date.UTC(2026, 9, 21, 15, 30);
    expect(rangeStart("today", now)).toBe(Date.UTC(2026, 9, 21));
    expect(rangeStart("mtd", now)).toBe(Date.UTC(2026, 9, 1));
    expect(rangeStart("ytd", now)).toBe(Date.UTC(2026, 0, 1));
    expect(rangeStart("7d", now)).toBe(Date.UTC(2026, 9, 15));
    expect(rangeStart("all", now)).toBe(0);
  });
});
